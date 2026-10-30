
/**
 * Module dependencies.
 */

var express = require('express')
  , session = require('express-session')
  , MySQLStore = require('express-mysql-session')(session)
  , mysql = require('mysql2/promise')
  , morgan = require('morgan')
  , http = require('http')
  , path = require('path')
  , sockjs  = require('sockjs')
  , whiskers = require('whiskers')
;

// i like to use lodash
var _ = require('lodash');

var config = require('./config');

// database setup
var db = require('./database');


// ORM setup
var User = require('./models/user');
var Rankings = require('./models/rankings');


// socksjs setup: browsers that need the iframe transport load the client from here
var sockjs_opts = {sockjs_url: "/vendor/sockjs-client/sockjs.min.js", log: function(severity, message) {
	if (severity !== 'debug') console.log('sockjs ' + severity + ': ' + message);
}};
var sockjs = sockjs.createServer(sockjs_opts);


// app setup
var app = express();

// set up whiskers templating engine
app.engine('.html', whiskers.__express);

// Azure App Service terminates TLS in front of us
if (config.production) app.set('trust proxy', 1);


// optional basic authentication for setting up closed testing sessions:
//  set environment variable BASIC_AUTH=username,password[|username,password]
function basicAuth(req, res, next) {
	var header = req.get('authorization') || '';
	var match = /^Basic (.+)$/.exec(header);
	if (match) {
		var decoded = Buffer.from(match[1], 'base64').toString();
		var sep = decoded.indexOf(':');
		var user = decoded.slice(0, sep), pass = decoded.slice(sep + 1);
		if (_.some(config.basicAuth, function(login) { return login[0] === user && login[1] === pass; })) return next();
	}
	res.set('WWW-Authenticate', 'Basic realm="SiSSYFiGHT testing"');
	res.status(401).send('Unauthorized');
}


// session store: sessions live in MySQL alongside everything else
var sessionPool = mysql.createPool({
	host: config.db.host,
	port: config.db.port,
	user: config.db.user,
	password: config.db.password,
	database: config.db.database,
	ssl: config.db.ssl ? {rejectUnauthorized: true} : undefined,
	connectionLimit: 5
});
var sessionStore = new MySQLStore({
	expiration: 12*60*60*1000,
	clearExpired: true,
	checkExpirationInterval: 15*60*1000,
	createDatabaseTable: true
}, sessionPool);
app.set('sessionStore', sessionStore);

// all environments
app.set('port', config.port);
app.set('views', __dirname + '/views');


// health check for the load balancer: is the app up and can it reach the database?
app.get('/healthz', function(req, res) {
	db.sequelize.query('SELECT 1').then(function() {
		res.send('ok');
	}, function(err) {
		console.log('healthz: database check failed: ' + err);
		res.status(503).send('database unavailable');
	});
});


var assetCacheTime = 60 * 60 * 1000; // one hour timeout during dev, change to a week or so when things are stable: 7 * 24 * 60 * 60 * 1000; // one week
app.use(express.static(path.join(__dirname, 'public'), {maxAge: assetCacheTime}));
app.use('/vendor/sockjs-client', express.static(path.dirname(require.resolve('sockjs-client/dist/sockjs.min.js')), {maxAge: assetCacheTime}));

// add authentication if set up
if (config.basicAuth) app.use(basicAuth);

if (process.env.NODE_ENV !== 'test') app.use(morgan(config.production ? 'combined' : 'dev'));
app.use(express.urlencoded({extended: false}));
app.use(express.json());
app.set('cookiekey', 'sf2k');
app.use(session({store: sessionStore
				, name: app.get('cookiekey')
				, secret: config.sessionSecret
				, resave: false
				, saveUninitialized: false
				, cookie: {maxAge: 12*60*60*1000, httpOnly: true, sameSite: 'lax', secure: config.production ? 'auto' : false}}));


// set up page controllers
require('./controllers/controllers')(app);
require('./controllers/admin_controllers')(app);


// load socket controllers
var sockjs_controllers = require('./controllers/sockjs');
// and initialize 'em
sockjs_controllers.init(app, sockjs);


// catchall
app.get('/user/*splat', function(req, res) {
	res.redirect('/');
});


// supposed to install sockjs handlers last
var server = http.createServer(app);
sockjs.installHandlers(server, {prefix:'/sox'});

// link up the announceToAll broadcast function
app.set('announceToAll', sockjs_controllers.announceToAll);

// schools
var School = require('./gameObjects/school');
// if in future we have more than one instance of each school, they should have ids like 666-1, 666-2, etc.
// Client uses the part before the - to decide which assets to load.
var schools = {
	'666': new School({id:'666', name:'PS 666', order:3}),
	'angel': new School({id:'angel', name:'Sweet Sunny Angel Valley Middle School', order:2}),
	'franklin': new School({id: 'franklin', name:'Benjamin Franklin Washington Jefferson Lincoln Junior High', order:1}),
	'suzy': new School({id: 'suzy', name:'Little Suzy Memorial High', order:4})
};
app.set('schools', schools);
app.set('schoolDefault', 'angel');
app.set('getSchoolInfo', function(id) {
	return schools[id];
});

// username rules
app.set('usernameRules', {minlength: 2, maxlength: 13, chars: "[A-Za-z0-9 !@#$_%^&*()+;:'<>\/\?\-]" });


// start listening, and schedule the monthly score rollover.
// Game state lives in this process, so run exactly one instance.
var rolloverJob;
function start(port) {
	var schedule = require('node-schedule');
	rolloverJob = schedule.scheduleJob({date: 1, hour: 4, minute: 0}, function() {
		Rankings.rollover();
	});

	process.on('SIGTERM', function() {
		console.log('SIGTERM: shutting down');
		server.close();
		setTimeout(function() { process.exit(0); }, 3000).unref();
	});

	return new Promise(function(resolve) {
		server.listen(port === undefined ? app.get('port') : port, function() {
			console.log('Express server listening on port ' + server.address().port);
			resolve(server);
		});
	});
}

// close database pools (for tests)
function stop() {
	if (rolloverJob) rolloverJob.cancel();
	return new Promise(function(resolve) {
		if (server.listening) {
			server.close(function() { resolve(); });
			server.closeAllConnections();
		}
		else resolve();
	}).then(function() {
		// the store doesn't end a pool it was handed, so end it here
		return Promise.all([sessionStore.close().then(function() { return sessionPool.end(); }), db.sequelize.close()]);
	});
}

if (require.main === module) start();

module.exports = {app: app, server: server, start: start, stop: stop}; // export it for test suite
