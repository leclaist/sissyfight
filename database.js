/*
	database: Sequelize connection to MySQL
*/
var Sequelize = require('sequelize');
var config = require('./config');

var sequelize = new Sequelize(config.db.database, config.db.user, config.db.password, {
	host: config.db.host,
	port: config.db.port,
	dialect: 'mysql',
	dialectOptions: config.db.ssl ? {ssl: {rejectUnauthorized: true}} : {},
	pool: {max: 10, min: 0, idle: 10000},
	logging: false
});


exports.Sequelize = Sequelize;
exports.sequelize = sequelize;

// run a raw query with :named replacements; resolves to rows for SELECT
exports.query = function(sql, replacements, type) {
	return sequelize.query(sql, {replacements: replacements || {}, type: type || Sequelize.QueryTypes.SELECT});
};

// settle a promise into a node-style callback, outside the promise chain so a
// throwing callback isn't swallowed or called twice
exports.nodeify = function(promise, callback) {
	promise.then(function(result) {
		process.nextTick(callback, null, result);
	}, function(err) {
		process.nextTick(callback, err);
	});
};
