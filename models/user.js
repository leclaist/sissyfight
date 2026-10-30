/*
	User model
*/
var crypto = require('crypto');
var db = require('../database');
var Op = db.Sequelize.Op;

// bcrypt for hashing passwords
var bcrypt = require('bcrypt');
var BCRYPT_ROUNDS = 10;

// text model to get password reset email text
var text = require('./text');
// whiskers for email templates
var whiskers = require('whiskers');
// nodemailer to send email
var config = require('../config');
var nodemailer = require('nodemailer');
var _ = require('lodash');


var User = db.sequelize.define('User', {
	nickname: {
		type: db.Sequelize.STRING(13),
		allowNull: false,
		defaultValue: "",
		unique: true,
		validate: {  //"[A-Za-z0-9 !@#$_%^&*()+;:'<>\/\?\-]"
			is: {args: /^[a-zA-Z0-9\-#$%*?+\/&!'@^()+;:<>.~_ ]+$/, msg: "Illegal character in nickname"},
			not: {args: /  /, msg: "Nickname can't have two spaces in a row"},
			len: {args: [2, 13], msg: "Nickname should be 2-13 letters long"}
		}
	},
	password: {
		type: db.Sequelize.STRING(60).BINARY,
		allowNull: true // unclaimed reserved accounts would have null password
	},

	avatar:	{
		type: db.Sequelize.TEXT,
		get: function() {
			var a = this.getDataValue('avatar');
			if (a && a.length) return JSON.parse(a);
			else return {};
		},
		set: function(v) {
			if (typeof v === "string") this.setDataValue('avatar', v);
			else this.setDataValue('avatar', JSON.stringify(v));
		},
		allowNull: false,
		defaultValue: "{}"
	},

	lastPlayed: db.Sequelize.DATE,

	// scoring ---------------
	month_points: 		{type: db.Sequelize.INTEGER, allowNull: false, defaultValue: 0},
	month_games: 		{type: db.Sequelize.INTEGER, allowNull: false, defaultValue: 0},
	month_wins: 		{type: db.Sequelize.INTEGER, allowNull: false, defaultValue: 0},
	month_wins_solo: 	{type: db.Sequelize.INTEGER, allowNull: false, defaultValue: 0},

	alltime_points: 	{type: db.Sequelize.INTEGER, allowNull: false, defaultValue: 0},
	alltime_games: 		{type: db.Sequelize.INTEGER, allowNull: false, defaultValue: 0},
	alltime_wins: 		{type: db.Sequelize.INTEGER, allowNull: false, defaultValue: 0},
	alltime_wins_solo: 	{type: db.Sequelize.INTEGER, allowNull: false, defaultValue: 0},


	// contact and password reset --------
	email: {
		type: db.Sequelize.STRING,
		allowNull: false
	},

	pwResetSent: db.Sequelize.DATE,

	pwResetCode: db.Sequelize.STRING(60),

	level: db.Sequelize.INTEGER

});


// mail transport is a property so tests can swap it out
User.mailtransport = config.email ? nodemailer.createTransport(config.email.transport) : null;


// the user properties kept in the session
User.sessionInfo = function(user) {
	return {nickname: user.nickname, id: user.id, level: user.level};
};


User.checkLogin = function(nickname, password, callback) {
	db.nodeify(User.findOne({where: {nickname: nickname, password: {[Op.ne]: null}}}).then(function(user) {
		if (!user) return null;
		return bcrypt.compare(password, user.password).then(function(passwordMatch) {
			return passwordMatch ? user : null;
		});
	}), callback);
};


// check if nickname is legal and not used. If email is not null, checks it is unused as well.
//   callback(err, status) - status is null for ok,
//		or {error: 'validation', msg: "Validation reason"}
//		or {error: 'taken', msg: "That nickname's already taken"
User.checkNicknameAndEmail = function(nickname, email, callback) {
	if (typeof nickname !== "string") {
		callback(null, {submitted:nickname, error:"validation", msg:"That's not a string"});
		return;
	}

	var temp = User.build({nickname: nickname, password: "placeholder", email: ""});
	var check = temp.validate().then(function() {
		return null;
	}, function(validation) {
		// didn't pass validation - pick one error message to pass on to user
		if (!validation.errors) throw validation;
		return {submitted:nickname, error:"validation", msg:validation.errors[0].message};
	}).then(function(status) {
		if (status) return status;
		if (/^robo/i.test(nickname)) return {submitted:nickname, error:"validation", msg:"Names starting with Robo are for bots"};
		// check if exists
		return User.findOne({where: {nickname: nickname}}).then(function(user) {
			if (user) return {submitted:nickname, error: "taken", msg:"That nickname's already taken"};
			if (!email) return null; // not checking email, and nickname was ok, so return success
			return User.findOne({where: {email: email}}).then(function(user) {
				if (user) return {submitted:email, error:"taken", msg:"That e-mail address is already in use."};
				return null; // neither nickname nor email matched.
			});
		});
	});
	db.nodeify(check, callback);
};


User.createUser = function(userdata, callback) {
	db.nodeify(bcrypt.hash(userdata.password, BCRYPT_ROUNDS).then(function(hash) {
		userdata.password = hash;
		return User.create(userdata);
	}), callback || function(err) {
		if (err) console.log("User.createUser: " + err);
	});
};


User.recordScore = function(userID, points, win, solo) {
	if (userID < 0) return Promise.resolve(); // bots have negative ids and aren't ranked
	
	var query = 'UPDATE Users '
		+ 'SET month_points = month_points + :points, alltime_points = alltime_points + :points,'
		+ ' month_games = month_games + 1, alltime_games = alltime_games + 1'

	if (win) {
		query = query + ', month_wins = month_wins + 1, alltime_wins = alltime_wins + 1';
		if (solo) {
			query = query + ', month_wins_solo = month_wins_solo + 1, alltime_wins_solo = alltime_wins_solo + 1'
		}
	}

	query = query + ' WHERE id = :id';

	return db.query(query, {id: userID, points: points}, db.Sequelize.QueryTypes.UPDATE).catch(function(err) {
		console.log('User.recordScore: failed for user ' + userID + ': ' + err);
	});
};


// validateAvatar returns null if avatar is ok, or error description otherwise
User.validateAvatar = function(avatar, level) {
	if (!avatar) return "no avatar";
	if ((typeof avatar) != 'object') return "not an object";

	// addon 402 (MadBetty's grayscale) uses one more than the highest regular color number
	var grayscale = Array.isArray(avatar.addons) && avatar.addons.indexOf(402) != -1;
	var grayscaleProps = ["skincolor", "haircolor", "uniformcolor"];

	//["face","skincolor","hairstyle","haircolor","uniform","uniformcolor","addons"]
	var props = ["face","skincolor","hairstyle","haircolor","uniform","uniformcolor"];
	for (var i=0; i<props.length; i++) {
		var p = props[i];
		var max = config.avatar.number.of[p];
		if (grayscale && grayscaleProps.indexOf(p) != -1) max++;
		if ((typeof avatar[p]) != 'number') return (p + " not a number: " + avatar[p]);
		if ((avatar[p] < 0) || (avatar[p] >= max)) return (p + " out of range: " + avatar[p]);
	}

	if (avatar.addons) {
		// figure out allowed addons by level
		var maxTier = 0, custom = 0;
		if (level <= 1) maxTier = 0;
		else if (level <= 3) maxTier = 1;
		else if (level <= 4) maxTier = 2;
		else if (level <= 6) maxTier = 3;
		else if (level <= 400) maxTier = 3;
		if (level >= 401 && level <= 499) {
			maxTier = 3;
			custom = level;
		}
		else if (level >= 500) {
			maxTier = 5;
		}

		if (!Array.isArray(avatar.addons)) return "addons not array";
		if (avatar.addons.length > 3) return "too many addons";
		for (var i=0; i<avatar.addons.length; i++) {
			var a = avatar.addons[i];
			if ((typeof a) != 'number') return ("addon id not a number: " + a);
			else {
				var addonInfo = _.find(config.avatar.addons, {id: a});
				if (!addonInfo) return ("no such addon id: " + a); // no such addon
				else if (addonInfo.tier < 0) return ("addon tier negative: " + a); // negative addons for dressing room mirror only
				else if (addonInfo.tier > maxTier) {	// custom avatars for their owners only
					if (custom==0 || addonInfo.id != custom) return ("addon " + a + " above tier for level " + level + ": tier " + addonInfo.tier);
				}
			}
		}

		// todo: check for addon conflicts
	}


	// it's ok i guess
	return null;
};


// send email with password reset code
//	callback(err) - err is null for success
User.requestPasswordResetEmail = function(nickname, email, callback) {
	// look up user by nickname and email
	var request = User.findOne({where: {nickname: nickname, email: email}}).then(function(user) {
		if (!user) throw "Couldn't find that name and email.";

		var secondsSinceLastRequest = (new Date() - user.pwResetSent) / 1000;

		// if they recently asked for a reset, give a success response but don't email again
		if (secondsSinceLastRequest < 12 * 60 * 60) return;

		if (!User.mailtransport) throw "Oops, can't send email now";

		return new Promise(function(resolve, reject) {
			text.retrieve('pwreset-email-%', function(err, texts) {
				if (err) reject(err);
				else resolve(texts);
			});
		}).then(function(texts) {
			// generate recovery code
			var code = crypto.randomBytes(24).toString('hex');
			var emailContent = {
				from: 		texts['pwreset-email-from'],
				to: 		email,
				subject: 	texts['pwreset-email-subject'],
				text:		whiskers.render(texts['pwreset-email-text'], {code: code, nickname: nickname, baseUrl: config.publicUrl})
			};
			// send mail! not waiting on the result, crossing fingers and assuming it works
			User.mailtransport.sendMail(emailContent, function(err, info) {
				if (err) console.log("nodemailer error", err);
				else console.log("nodemailer success", info.messageId);
			});

			// update user record with new code
			user.pwResetSent = new Date();
			user.pwResetCode = code;
			return user.save();
		});
	}).then(function() {
		return null;
	});
	db.nodeify(request, callback);
};


// reset user's password by email and reset code
//	callback(err, nickname) - if success, returns affected user's nickname
User.resetPassword = function(email, code, newpassword, callback) {
	var reset = bcrypt.hash(newpassword, BCRYPT_ROUNDS).then(function(hash) {
		var now = new Date();
		return db.query(
			'SELECT id, nickname FROM Users ' +
			'WHERE email=:email AND pwResetCode=:code AND (TIME_TO_SEC(TIMEDIFF(:now, pwResetSent))) < :daysecs ',
			{email: email, code: code, now: now, daysecs: 24*60*60}
		).then(function(result) {
			if (result.length == 0) {
				throw "Wrong email, or reset link's too old";
			}
			else if (result.length > 1) {
				console.log("Password reset trouble! More than one match for email and code! ", email, code);
				throw "Something went wrong.";
			}
			// update user's password, and use up the code
			var id = result[0].id, nickname = result[0].nickname;
			return db.query(
				'UPDATE Users SET password=:hashedpassword, pwResetSent=NULL, pwResetCode=NULL WHERE id=:id LIMIT 1',
				{id: id, hashedpassword: hash},
				db.Sequelize.QueryTypes.UPDATE
			).then(function() {
				return nickname;
			});
		});
	});
	db.nodeify(reset, function(err, nickname) {
		if (err && typeof err !== 'string') console.log("Password reset for " + email + " failed with db error " + err);
		callback(err, nickname);
	});
};



module.exports = User;
