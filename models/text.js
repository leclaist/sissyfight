/*
	Text model - for storing boilerplate text like homepage announcements, email content, etc.
*/
var db = require('../database');
var Op = db.Sequelize.Op;


var Text = db.sequelize.define('Text', {

	key: {
		type: db.Sequelize.STRING(60),
		allowNull: false,
		primaryKey: true
	},

	text: {
		type: db.Sequelize.TEXT,
		allowNull: false
	},

	// cache time to live in seconds
	// NOT YET IMPLEMENTED
	cache_ttl: {
		type: db.Sequelize.INTEGER,
		allowNull: true
	}

}, {
	timestamps: false
});


// retrieve: quick and dirty lookup of one or more texts: can use sql wildcard to match multiple keys.
//	callback(err, texts)
//		e.g. retrieve('pwreset-email-%') -> {pwreset-email-text: "", pwreset-email-subject: "", pwreset-email-from: ""}
Text.retrieve = function(keys, callback) {
	db.nodeify(Text.findAll({where: {key: {[Op.like]: keys}}}).then(function(records) {
		var texts = {};
		records.forEach(function(record) {
			texts[record.key] = record.text;
		});
		return texts;
	}), callback);
};


module.exports = Text;
