/*
	db-setup: create tables and default texts from database_tables.sql.
	Idempotent - run on every deploy: `npm run db:setup`
*/
var fs = require('fs');
var path = require('path');
var db = require('../database');

var sql = fs.readFileSync(path.join(__dirname, '../database_tables.sql'), 'utf8');

// strip comment lines and split into statements
var statements = sql.split('\n').filter(function(line) {
	return !/^\s*--/.test(line);
}).join('\n').split(/;\s*\n/).map(function(s) {
	return s.trim();
}).filter(Boolean);

module.exports = function setup() {
	return statements.reduce(function(previous, statement) {
		return previous.then(function() {
			return db.sequelize.query(statement, {type: db.Sequelize.QueryTypes.RAW});
		});
	}, Promise.resolve());
};

if (require.main === module) {
	module.exports().then(function() {
		console.log('db-setup: ran ' + statements.length + ' statements');
		return db.sequelize.close();
	}, function(err) {
		console.error('db-setup failed:', err.message);
		process.exit(1);
	});
}
