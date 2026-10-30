/*
	Integration tests: HTTP routes, the socket login handshake, and the
	database queries, against a real MySQL (TEST_DATABASE_URL).
		docker compose run --rm app npm test
*/
'use strict';

const test = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
	test('server tests', {skip: 'TEST_DATABASE_URL not set'}, function() {});
	return;
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
process.env.MAIL_TRANSPORT = 'json';
process.env.PUBLIC_URL = 'https://sissyfight.example';

const quiet = console.log;
console.log = function() {};

const db = require('../database');
const setupDatabase = require('../scripts/db-setup');
const sfapp = require('../app');
const User = require('../models/user');
const Rankings = require('../models/rankings');

let base, wsBase;

// minimal browser: keeps the session cookie between requests
function browser() {
	let cookie = '';
	async function request(method, path, form) {
		const res = await fetch(base + path, {
			method: method,
			redirect: 'manual',
			headers: Object.assign({cookie: cookie}, form ? {'content-type': 'application/x-www-form-urlencoded'} : {}),
			body: form ? new URLSearchParams(form).toString() : undefined
		});
		const setCookie = res.headers.getSetCookie().find(function(c) { return c.startsWith('sf2k='); });
		if (setCookie) cookie = setCookie.split(';')[0];
		const text = await res.text();
		let json;
		try { json = JSON.parse(text); } catch (e) {}
		return {status: res.status, headers: res.headers, text: text, json: json};
	}
	return {
		get: function(path) { return request('GET', path); },
		post: function(path, form) { return request('POST', path, form); }
	};
}

function signupForm(nickname, extra) {
	return Object.assign({newname: nickname, password: 'secret123', email: nickname + '@example.com', dob_year: '1990', dob_month: '04', dob_day: '01'}, extra);
}

async function signedUpBrowser(nickname) {
	const b = browser();
	const res = await b.post('/u/new', signupForm(nickname));
	assert.strictEqual(res.json.ok, true, JSON.stringify(res.json));
	return b;
}

async function gamePageAuth(b) {
	const page = await b.get('/game/angel');
	assert.strictEqual(page.status, 200);
	return {
		token: /var token = '([^']*)'/.exec(page.text)[1],
		session: /var session = '([^']*)'/.exec(page.text)[1]
	};
}

// raw sockjs websocket endpoint: plain text frames, no sockjs framing
function socket() {
	const ws = new WebSocket(wsBase + '/sox/websocket');
	const queue = [], waiting = [];
	ws.addEventListener('message', function(e) {
		const msg = JSON.parse(e.data);
		const w = waiting.findIndex(function(w) { return w.type === msg.type; });
		if (w !== -1) waiting.splice(w, 1)[0].resolve(msg.data);
		else queue.push(msg);
	});
	return {
		open: new Promise(function(resolve, reject) {
			ws.addEventListener('open', resolve);
			ws.addEventListener('error', reject);
		}),
		send: function(type, data) { ws.send(JSON.stringify({type: type, data: data})); },
		next: function(type) {
			const q = queue.findIndex(function(m) { return m.type === type; });
			if (q !== -1) return Promise.resolve(queue.splice(q, 1)[0].data);
			return new Promise(function(resolve, reject) {
				waiting.push({type: type, resolve: resolve});
				setTimeout(function() { reject(new Error('timed out waiting for ' + type)); }, 3000).unref();
			});
		},
		close: function() {
			ws.close();
			return new Promise(function(resolve) { ws.addEventListener('close', resolve); });
		}
	};
}

const goodAvatar = {face: 1, skincolor: 2, hairstyle: 3, haircolor: 4, uniform: 0, uniformcolor: 0, addons: []};


test.before(async function() {
	await setupDatabase();
	await db.sequelize.query('DELETE FROM MonthlyScores');
	await db.sequelize.query('DELETE FROM Users');
	const server = await sfapp.start(0);
	base = 'http://127.0.0.1:' + server.address().port;
	wsBase = 'ws://127.0.0.1:' + server.address().port;
});

test.after(async function() {
	await sfapp.stop();
	console.log = quiet;
});


test('health check reports the database is reachable', async function() {
	const res = await browser().get('/healthz');
	assert.strictEqual(res.status, 200);
	assert.strictEqual(res.text, 'ok');
});

test('static files and the vendored sockjs client are served', async function() {
	const b = browser();
	assert.strictEqual((await b.get('/client/Comm.js')).status, 200);
	assert.strictEqual((await b.get('/vendor/sockjs-client/sockjs.min.js')).status, 200);
});

test('main page renders with header include and school populations', async function() {
	const res = await browser().get('/main');
	assert.strictEqual(res.status, 200);
	assert.ok(res.text.length > 1000);
	assert.ok(res.text.indexOf('{includes') === -1, 'unrendered template tag');
});

test('site pages render; unknown pages and traversal are 404', async function() {
	const b = browser();
	for (const page of ['credits.html', 'help.html', 'honorcode.html', 'rankings.html']) {
		assert.strictEqual((await b.get('/pages/' + page)).status, 200, page);
	}
	assert.strictEqual((await b.get('/pages/nope.html')).status, 404);
	assert.strictEqual((await b.get('/pages/..%2Fmain.html')).status, 404);
});

test('checkNameDOB validates age and nickname', async function() {
	const b = browser();
	const check = function(newname, year) {
		return b.post('/u/checkNameDOB', {newname: newname, dob_year: year || '1990', dob_month: '01', dob_day: '01'});
	};
	assert.strictEqual((await check('kiddo', String(new Date().getFullYear() - 5))).json.underage, true);
	assert.strictEqual((await check('a')).json.message, 'Nickname should be 2-13 letters long');
	assert.strictEqual((await check('bad{name')).json.message, 'Illegal character in nickname');
	assert.strictEqual((await check('two  spaces')).json.message, "Nickname can't have two spaces in a row");
	assert.strictEqual((await check("ok!name's")).json.ok, true);
	assert.strictEqual((await check('robobecky')).json.message, 'Names starting with Robo are for bots');
	assert.deepStrictEqual((await b.post('/u/checkNameDOB', {})).json, {ok: false});
});

test('signup, duplicate checks, and login', async function() {
	await signedUpBrowser('sally');

	const dupName = await browser().post('/u/new', signupForm('SALLY', {email: 'other@example.com'}));
	assert.strictEqual(dupName.json.error, 'taken');
	const dupEmail = await browser().post('/u/new', signupForm('sally2', {email: 'sally@example.com'}));
	assert.strictEqual(dupEmail.json.message, 'That e-mail address is already in use.');

	const b = browser();
	assert.strictEqual((await b.post('/u/login', {nickname: 'sally', password: 'wrong'})).json.ok, false);
	const login = await b.post('/u/login', {nickname: ' sally ', password: 'secret123'});
	assert.deepStrictEqual(login.json, {ok: true, nickname: 'sally', message: ''});

	// sessions only hold the public user info, never the password hash
	const rows = await db.query('SELECT data FROM sessions');
	assert.ok(rows.length > 0);
	rows.forEach(function(row) { assert.ok(row.data.indexOf('$2b$') === -1, 'password hash in session'); });

	const logout = await b.get('/user/logout');
	assert.strictEqual(logout.status, 302);
	assert.strictEqual((await b.get('/game/angel')).headers.get('location'), '/main');
});

test('socket login handshake, avatar save, and homeroom', async function() {
	const b = await signedUpBrowser('bettyboo');
	const auth = await gamePageAuth(b);

	const bad = socket();
	await bad.open;
	bad.send('login', {session: auth.session, token: 'not-the-token'});
	assert.strictEqual((await bad.next('loginError')).error, 'token');
	await bad.close();

	const s = socket();
	await s.open;
	s.send('login', auth);
	const go = await s.next('go');
	assert.strictEqual(go.to, 'dressingroom');
	assert.strictEqual(go.nickname, 'bettyboo');

	// a second socket for the same user is refused
	const dup = socket();
	await dup.open;
	dup.send('login', auth);
	assert.strictEqual((await dup.next('loginError')).error, 'multi');
	await dup.close();

	s.send('saveAvatar', {avatar: Object.assign({}, goodAvatar, {face: 99})});
	assert.strictEqual((await s.next('error')).error, 'badavatar');

	s.send('saveAvatar', {avatar: goodAvatar});
	const homeroom = await s.next('go');
	assert.strictEqual(homeroom.to, 'homeroom');
	assert.ok(Array.isArray(homeroom.games));
	assert.deepStrictEqual(homeroom.avatar, goodAvatar);
	await s.close();

	const saved = await User.findOne({where: {nickname: 'bettyboo'}});
	assert.deepStrictEqual(saved.avatar, goodAvatar);
});

test('validateAvatar checks every field (it used to stop after face)', function() {
	assert.strictEqual(User.validateAvatar(goodAvatar, 1), null);
	assert.match(User.validateAvatar(Object.assign({}, goodAvatar, {uniform: 5}), 1), /uniform out of range/);
	assert.match(User.validateAvatar(Object.assign({}, goodAvatar, {haircolor: 'x'}), 1), /haircolor not a number/);
	// MadBetty's grayscale addon uses one past the regular colors
	assert.strictEqual(User.validateAvatar(Object.assign({}, goodAvatar, {skincolor: 6, haircolor: 8, uniformcolor: 6, addons: [402]}), 402), null);
	assert.match(User.validateAvatar(Object.assign({}, goodAvatar, {addons: [402]}), 1), /above tier/);
});

test('scores, rankings, and the monthly rollover', async function() {
	const names = ['winner', 'second', 'third', 'idle'];
	const ids = {};
	for (const name of names) {
		const user = await User.create({nickname: name, email: name + '@example.com', avatar: goodAvatar});
		ids[name] = user.id;
	}
	await User.recordScore(ids.winner, 60, true, true);
	await User.recordScore(ids.winner, 30, true, false);
	await User.recordScore(ids.second, 30, true, false);
	await User.recordScore(ids.second, 0, false); // 50% wins, so no tie with winner (ties share the lower rank)
	await User.recordScore(ids.third, 10, false);

	const call = function(fn) {
		const args = Array.prototype.slice.call(arguments, 1);
		return new Promise(function(resolve, reject) {
			fn.apply(null, args.concat(function(err, result) { if (err) reject(err); else resolve(result); }));
		});
	};

	const top = await call(Rankings.thisMonth, 100);
	assert.deepStrictEqual(top.map(function(r) { return r.nickname; }), ['winner', 'second', 'third']);
	assert.strictEqual(top[0].month_points, 90);
	assert.strictEqual(Number(top[0].month_win_pct), 100);
	assert.deepStrictEqual(top[0].avatar, goodAvatar);

	const me = await call(Rankings.thisMonthUserInfo, ids.second);
	assert.strictEqual(me.points_rank, 2);
	const idle = await call(Rankings.thisMonthUserInfo, ids.idle);
	assert.strictEqual(idle.points_rank, undefined);

	await call(Rankings.rollover);
	// running it twice in a month must not double-record
	await call(Rankings.rollover);

	const monthly = await db.query('SELECT * FROM MonthlyScores ORDER BY month_points_rank');
	assert.deepStrictEqual(monthly.map(function(r) { return [r.id, r.month_points, r.month_points_rank, r.month_win_pct_rank, r.month_fame_points]; }), [
		[ids.winner, 90, 1, 1, 25],
		[ids.second, 30, 2, 2, 24],
		[ids.third, 10, 3, 3, 23]
	]);
	const reset = await db.query('SELECT SUM(month_points) AS points, SUM(alltime_points) AS alltime FROM Users');
	assert.strictEqual(Number(reset[0].points), 0);
	assert.strictEqual(Number(reset[0].alltime), 130);

	const month = monthly[0].record_month;
	const past = await call(Rankings.pastMonth, null, null);
	assert.deepStrictEqual(past[month].map(function(r) { return r.nickname; }), ['winner', 'second', 'third']);
	assert.strictEqual((await call(Rankings.pastMonth, month, ids.second))[month].nickname, 'second');
	assert.deepStrictEqual((await call(Rankings.getMonths)).map(function(r) { return r.record_month; }), [month]);

	const fame = await call(Rankings.hallOfFame, 100);
	assert.deepStrictEqual(fame.map(function(r) { return [r.nickname, Number(r.total_fame), r.rank]; }), [['winner', 25, 1], ['second', 24, 2], ['third', 23, 3]]);

	// and the rankings page renders with real data, logged in or not
	const page = await browser().get('/pages/rankings.html');
	assert.strictEqual(page.status, 200);
	assert.ok(page.text.indexOf('winner') !== -1);
	const b = await signedUpBrowser('ranker');
	assert.strictEqual((await b.get('/pages/rankings.html')).status, 200);
});

test('password reset by email', async function() {
	await signedUpBrowser('forgetful');
	const sent = [];
	const realTransport = User.mailtransport;
	User.mailtransport = {sendMail: function(mail, cb) { sent.push(mail); cb(null, {messageId: 'test'}); }};
	try {
		const b = browser();
		assert.strictEqual((await b.post('/u/requestReset', {resetnickname: 'forgetful', resetemail: 'wrong@example.com'})).json.ok, false);
		assert.strictEqual((await b.post('/u/requestReset', {resetnickname: 'forgetful', resetemail: 'forgetful@example.com'})).json.ok, true);
		// a second request soon after doesn't send another email
		assert.strictEqual((await b.post('/u/requestReset', {resetnickname: 'forgetful', resetemail: 'forgetful@example.com'})).json.ok, true);
		assert.strictEqual(sent.length, 1);
		assert.strictEqual(sent[0].to, 'forgetful@example.com');
		const code = /https:\/\/sissyfight\.example\/reset\/([0-9a-f]+)/.exec(sent[0].text)[1];

		assert.strictEqual((await b.get('/reset/' + code)).status, 200);
		assert.strictEqual((await b.post('/u/resetPassword', {email: 'forgetful@example.com', code: 'nope', password: 'x'})).json.ok, false);
		const reset = await b.post('/u/resetPassword', {email: 'forgetful@example.com', code: code, password: 'newpass456'});
		assert.deepStrictEqual(reset.json, {ok: true, nickname: 'forgetful'});
		// the code only works once
		assert.strictEqual((await b.post('/u/resetPassword', {email: 'forgetful@example.com', code: code, password: 'again'})).json.ok, false);

		assert.strictEqual((await b.post('/u/login', {nickname: 'forgetful', password: 'newpass456'})).json.ok, true);
	}
	finally {
		User.mailtransport = realTransport;
	}
});

test('admin pages are hidden from regular users', async function() {
	const b = await signedUpBrowser('notadmin');
	assert.strictEqual((await b.get('/admin/announce')).status, 404);
});
