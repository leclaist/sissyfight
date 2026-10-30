/*
	dev-bots: scripted players for local testing, so one person can play a real
	game (it takes at least 3 players to start).

		node scripts/dev-bots.js [count=2] [school=angel] [baseUrl=http://localhost:3000]

	Each bot signs up (or logs in) as botN, picks an avatar, and joins the first
	open game room in the school that has a human in it. In the room it presses
	Start, then makes a random move every turn.
*/
'use strict';

var count = parseInt(process.argv[2] || '2', 10);
var school = process.argv[3] || 'angel';
var base = (process.argv[4] || 'http://localhost:3000').replace(/\/$/, '');
var MOVES = ['cower', 'lick', 'tattle', 'grab', 'scratch', 'tease'];

function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

function Bot(n) {
	this.name = 'bot' + n;
	this.cookie = '';
	this.id = null;
	this.room = null;
	this.players = [];
}

Bot.prototype.log = function() {
	console.log.apply(console, ['[' + this.name + ']'].concat(Array.prototype.slice.call(arguments)));
};

Bot.prototype.request = async function(method, path, form) {
	var res = await fetch(base + path, {
		method: method,
		redirect: 'manual',
		headers: Object.assign({cookie: this.cookie}, form ? {'content-type': 'application/x-www-form-urlencoded'} : {}),
		body: form ? new URLSearchParams(form).toString() : undefined
	});
	var setCookie = res.headers.getSetCookie().find(function(c) { return c.startsWith('sf2k='); });
	if (setCookie) this.cookie = setCookie.split(';')[0];
	return res.text();
};

Bot.prototype.start = async function() {
	var login = JSON.parse(await this.request('POST', '/u/login', {nickname: this.name, password: 'botbotbot'}));
	if (!login.ok) {
		var signup = JSON.parse(await this.request('POST', '/u/new', {
			newname: this.name, password: 'botbotbot', email: this.name + '@bots.invalid',
			dob_year: '1999', dob_month: '01', dob_day: '01'
		}));
		if (!signup.ok) throw new Error(this.name + ' signup failed: ' + signup.message);
	}
	var page = await this.request('GET', '/game/' + school);
	var auth = {
		token: /var token = '([^']*)'/.exec(page)[1],
		session: /var session = '([^']*)'/.exec(page)[1]
	};

	var bot = this;
	this.ws = new WebSocket(base.replace(/^http/, 'ws') + '/sox/websocket');
	this.ws.addEventListener('open', function() { bot.send('login', auth); });
	this.ws.addEventListener('message', function(e) {
		var msg = JSON.parse(e.data);
		bot.handle(msg.type, msg.data);
	});
	this.ws.addEventListener('close', function() { bot.log('disconnected'); });
	setInterval(function() { if (bot.room) bot.send('ping', {}); }, 5000);
};

Bot.prototype.send = function(type, data) {
	this.ws.send(JSON.stringify({type: type, data: data}));
};

Bot.prototype.handle = function(type, data) {
	if (type === 'loginError' || type === 'error') return this.log(type, data);
	if (type === 'go') return this.go(data);
	if (type === 'gameUpdate' && !this.room) return this.considerRoom(data.roomInfo);
	if (type === 'gameEvent') return this.gameEvent(data);
	if (type === 'join' && this.room) this.players.push(data.id);
	if (type === 'leave' && this.room) this.players = this.players.filter(function(id) { return id !== data.id; });
};

Bot.prototype.go = function(data) {
	var bot = this;
	if (data.to === 'dressingroom') {
		this.send('saveAvatar', {avatar: {
			face: Math.floor(Math.random() * 8), skincolor: Math.floor(Math.random() * 6),
			hairstyle: Math.floor(Math.random() * 13), haircolor: Math.floor(Math.random() * 8),
			uniform: Math.floor(Math.random() * 5), uniformcolor: 0, addons: []
		}});
	}
	else if (data.to === 'homeroom') {
		this.room = null;
		this.log('in homeroom, waiting for a game room with a human in it');
		(data.games || []).forEach(function(info) { if (!bot.room) bot.considerRoom(info); });
	}
	else if (data.to === 'gameroom') {
		this.room = data.room.room;
		this.id = data.me;
		this.players = data.room.occupants.map(function(o) { return o.id; });
		this.log('joined "' + data.room.roomName + '", pressing start');
		this.send('act', {action: 'start'});
	}
};

// join an open room that has at least one human in it
Bot.prototype.considerRoom = function(info) {
	if (!info || info.status !== 'open' || this.joining === info.room) return;
	var humans = (info.occupants || []).filter(function(o) { return !/^bot\d+$/.test(o.nickname); });
	if (humans.length === 0) return;
	this.joining = info.room;
	this.send('joingame', {room: info.room});
};

Bot.prototype.gameEvent = function(data) {
	var bot = this;
	if (data.event === 'startTurn') {
		var others = this.players.filter(function(id) { return id !== bot.id; });
		var action = pick(MOVES);
		var move = {action: action};
		if (action === 'grab' || action === 'scratch' || action === 'tease') move.target = pick(others);
		setTimeout(function() {
			bot.send('act', move);
			bot.send('act', {action: 'timeout'});
		}, 1000 + Math.random() * 2000);
	}
	else if (data.event === 'endGame') {
		this.log('game over, heading back to the homeroom');
		setTimeout(function() { bot.joining = null; bot.send('homeroom', {}); }, 3000);
	}
};

for (var i = 1; i <= count; i++) {
	new Bot(i).start().catch(function(err) { console.error(err.message); process.exit(1); });
}
