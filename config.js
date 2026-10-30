/*
	config: all environment-driven configuration lives here.

	Environment variables:
		DATABASE_URL		mysql://user:password@host:3306/database
		SISSYFIGHT_DB		legacy form: mysql|host|database|user|password (used if DATABASE_URL is unset)
		DB_SSL				set to "true" to require TLS to MySQL (needed for Azure Database for MySQL)
		SESSION_SECRET		secret for signing session cookies (required in production)
		SENDGRID_API_KEY	SendGrid API key, sent over SMTP
		SISSYFIGHT_MAILER	legacy form: service|user|password (any nodemailer well-known service)
		MAIL_TRANSPORT		set to "json" to log emails instead of sending them (dev/test)
		PUBLIC_URL			base URL used in emailed links, e.g. https://play.sissyfight.com
		BASIC_AUTH			optional closed-testing logins: user,password[|user,password...]
		ANTHROPIC_API_KEY	lets bots use Claude for moves and chat (without it they play randomly and stay quiet)
		BOTS				set to "off" to disable bot players
		BOT_MODEL			Claude model for bots (default claude-haiku-5-5)
		BOT_DAILY_CALL_LIMIT	cap on model calls per day (default 3000); bots play randomly past it
		PORT				http port (default 3000)
*/
var fs = require('fs');
var path = require('path');

var env = process.env;
var production = env.NODE_ENV === 'production';

exports.production = production;
exports.port = parseInt(env.PORT, 10) || 3000;
exports.publicUrl = (env.PUBLIC_URL || ('http://localhost:' + exports.port)).replace(/\/$/, '');


// database
function parseDatabase() {
	if (env.DATABASE_URL) {
		var url = new URL(env.DATABASE_URL);
		return {
			host: url.hostname,
			port: url.port ? parseInt(url.port, 10) : 3306,
			database: decodeURIComponent(url.pathname.replace(/^\//, '')),
			user: decodeURIComponent(url.username),
			password: decodeURIComponent(url.password)
		};
	}
	if (env.SISSYFIGHT_DB) {
		var parts = env.SISSYFIGHT_DB.split('|'); // dialect|hostname|database name|username|password
		return {host: parts[1], port: 3306, database: parts[2], user: parts[3], password: parts[4]};
	}
	throw new Error("Missing database configuration: set DATABASE_URL (or SISSYFIGHT_DB)");
}
exports.db = parseDatabase();
exports.db.ssl = env.DB_SSL === 'true';


// sessions
if (!env.SESSION_SECRET && production) throw new Error("Missing SESSION_SECRET");
if (!env.SESSION_SECRET) console.log("SESSION_SECRET not set - using an insecure development secret");
exports.sessionSecret = env.SESSION_SECRET || 'insecure-development-secret';


// email
if (env.MAIL_TRANSPORT === 'json') {
	exports.email = {transport: {jsonTransport: true}};
}
else if (env.SENDGRID_API_KEY) {
	exports.email = {transport: {service: 'SendGrid', auth: {user: 'apikey', pass: env.SENDGRID_API_KEY}}};
}
else if (env.SISSYFIGHT_MAILER) {
	// service is one of nodemailer's well-known services
	var email_info = env.SISSYFIGHT_MAILER.split('|');
	exports.email = {transport: {service: email_info[0], auth: {user: email_info[1], pass: email_info[2]}}};
}
else {
	console.log("No email configured (SENDGRID_API_KEY) - password reset emails are disabled");
	exports.email = null;
}


// optional basic auth for closed testing sessions: [[username, password], ...]
exports.basicAuth = env.BASIC_AUTH ? env.BASIC_AUTH.split('|').map(function(userAndPassword) {
	return userAndPassword.split(',');
}) : null;


// bot players
exports.bots = {
	enabled: env.BOTS !== 'off',
	apiKey: env.ANTHROPIC_API_KEY || null,
	model: env.BOT_MODEL || 'claude-haiku-5-5',
	dailyCallLimit: parseInt(env.BOT_DAILY_CALL_LIMIT, 10) || 3000,
	perMinuteLimit: 120,
	fillDelayMs: 20000,		// how long humans wait in a regular room before bots fill it
	thinkDelayMs: 2500		// bots take a moment before acting, like a person would
};


exports.schools = {

	// names for rooms the server will create if all existing rooms are full
	roomNames: {
		'666': 'Sacrifice Altar, My Dark Master, Lockdown, Surveillance, No Fun For You, Tattoo Corner, Will to Survive, Sissy Fortress, Visiting Hours, Exercise Period, The Pentagram, Witchcraft 101, Curses!, Unholy Glee, HellfireClub, The Pit, Deadly Seven, Fangs R Us'.split(/,\s*/),
		'franklin': 'Chem Lab, Janitor\'s Closet, Third Bathroom, Boiler Room, Chess Club, Broken Window, Back Door, Pizza Shop, Dead Cat, Detox, Instant A, Math is Hard!, High Achievers, Copy This!, Burnt Toast'.split(/,\s*/),
		'angel': 'Aww Gee Whiz!, Snugglebumpkins, Fuzzy Things, Nice Dress!, Cheerleading, I Luv Ponies, Teddy Bears, Happy Flowers, Who\'s Richer?, Gossip, Boys Are Icky, Popularity 101, Pep Squad, Good Clean Fun, Pretty Rainbows, BMW Bike Club, Straight A Club, Smile Every Day'.split(/,\s*/),
		'suzy': 'Aww Gee Whiz!, Snugglebumpkins, Fuzzy Things, Nice Dress!, Cheerleading, I Luv Ponies, Teddy Bears, Happy Flowers, Who\'s Richer?, Gossip, Boys Are Icky, Popularity 101, Pep Squad, Good Clean Fun, Pretty Rainbows, BMW Bike Club, Straight A Club, Smile Every Day'.split(/,\s*/),
	}

};


exports.avatar = {
	number: {of: {}}
};
// todo: this info should be unified between client and server:
exports.avatar.number.of = {
	face: 			8,
	skincolor: 		6, 	// can't trust config.colors.skin.vars.length now that we have the extra grayscale
	hairstyle: 		13,
	haircolor: 		8, 	// ditto config.colors.hair.vars.length,
	uniform: 		5,
	uniformcolor: 	6,	// ditto config.colors.uniforms.vars.length
	expression:		7,
	pose:			9
}
// public/client/addons.js is a browser script of the form `config.addons = [...json...];`
var addonsSource = fs.readFileSync(path.join(__dirname, 'public/client/addons.js'), 'utf8');
exports.avatar.addons = JSON.parse(addonsSource.replace(/^\s*config\.addons\s*=\s*/, '').replace(/;\s*$/, ''));
