/*
	BotManager: decides when bots come and go in one school's game rooms.

	- Bot rooms (created by School with {bots: true}): when a human walks in,
	  bots fill the room to BOT_ROOM_PLAYERS so a game can start right away.
	- Regular rooms: if humans have been waiting without enough players for a
	  game (3), bots join after config.bots.fillDelayMs to make up the numbers.
	- Bots never stay in a room without humans, and booted bots aren't replaced.
*/
var _ = require('lodash');
var config = require('../config');
var brain = require('./brain');
var BotPlayer = require('./botplayer');

var BOT_ROOM_PLAYERS = 4;
var MIN_PLAYERS = 3;
var CHAT_HISTORY = 12;
var CHAT_COOLDOWN_MS = 5000;

function BotManager(school) {
	this.school = school;
	this.rooms = {}; // room id -> {bots, fillTimer, booted, chat, lastReply}
}

BotManager.prototype.watch = function(room) {
	var manager = this;
	room.on('update', function(event) {
		// let the join/leave that caused this finish before reacting to it
		setImmediate(function() {
			if (event.update === 'destroy') manager.dismiss(room);
			else manager.check(room);
		});
	});
};

BotManager.prototype.state = function(room) {
	if (!this.rooms[room.id]) this.rooms[room.id] = {bots: [], fillTimer: null, booted: 0, chat: [], lastReply: 0};
	return this.rooms[room.id];
};

BotManager.prototype.thinkDelay = function() {
	return config.bots.thinkDelayMs;
};

BotManager.prototype.humans = function(room) {
	return room.occupants.filter(function(conn) { return !conn.isBot; });
};

BotManager.prototype.check = function(room) {
	if (this.school.games[room.id] !== room) return this.dismiss(room);
	var state = this.state(room);
	var humans = this.humans(room).length;

	if (humans === 0) return this.dismiss(room);
	if (room.game) return this.cancelFill(state);

	if (room.bots) {
		this.fill(room, Math.min(room.maxUsers, BOT_ROOM_PLAYERS) - state.booted);
	}
	else if (room.occupants.length >= MIN_PLAYERS || state.booted > 0) {
		this.cancelFill(state);
	}
	else if (!state.fillTimer) {
		var manager = this;
		state.fillTimer = setTimeout(function() {
			state.fillTimer = null;
			if (manager.humans(room).length > 0 && !room.game) manager.fill(room, MIN_PLAYERS);
		}, config.bots.fillDelayMs);
		state.fillTimer.unref();
	}
};

// add bots until the room has `total` players
BotManager.prototype.fill = function(room, total) {
	var state = this.state(room);
	var needed = Math.min(total, room.maxUsers) - room.occupants.length;
	for (var i = 0; i < needed; i++) {
		var bot = new BotPlayer(this, room);
		if (!bot.join()) break;
		state.bots.push(bot);
	}
};

BotManager.prototype.cancelFill = function(state) {
	if (state.fillTimer) {
		clearTimeout(state.fillTimer);
		state.fillTimer = null;
	}
};

// all bots leave the room
BotManager.prototype.dismiss = function(room) {
	var state = this.rooms[room.id];
	if (!state) return;
	this.cancelFill(state);
	state.bots.slice().forEach(function(bot) { bot.leave(); });
	delete this.rooms[room.id];
};

BotManager.prototype.forget = function(bot) {
	var state = this.rooms[bot.room.id];
	if (state) _.pull(state.bots, bot);
};

// humans voted a bot out: don't bring in a replacement
BotManager.prototype.booted = function(bot) {
	this.state(bot.room).booted++;
};


// --- chat --------------------------------------------------------------------

BotManager.prototype.recentChat = function(room) {
	return this.rooms[room.id] ? this.rooms[room.id].chat.slice() : [];
};

// every bot in the room receives each chat line; only the first one records it
BotManager.prototype.chatSeen = function(bot, data) {
	var state = this.rooms[bot.room.id];
	if (!state || state.bots[0] !== bot) return;
	state.chat.push({nickname: data.nickname, text: data.text});
	if (state.chat.length > CHAT_HISTORY) state.chat.shift();
	if (data.id > 0) this.maybeReply(bot.room, state, data);
};

BotManager.prototype.maybeReply = function(room, state, data) {
	var now = Date.now();
	if (now - state.lastReply < CHAT_COOLDOWN_MS) return;

	// a bot that was named answers; otherwise sometimes someone chimes in
	var text = String(data.text).toLowerCase();
	var named = _.find(state.bots, function(bot) { return text.indexOf(bot.nickname.toLowerCase()) !== -1; });
	var responder = named || (Math.random() < 0.5 ? _.sample(state.bots) : null);
	if (!responder) return;
	state.lastReply = now;

	var gameState = responder.gameState() || {
		turn: 0,
		me: {nickname: responder.nickname, health: 10, lollies: 3, tattles: 2},
		others: this.humans(room).map(function(c) { return {id: c.user.id, nickname: c.user.nickname, health: 10}; }),
		out: [], allowed: brain.MOVES, lastTurn: [], chat: this.recentChat(room)
	};
	brain.chatReply(responder, gameState).then(function(reply) {
		if (reply) responder.later(function() { responder.say(reply); });
	});
};

module.exports = BotManager;
