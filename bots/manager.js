/*
	BotManager: decides when bots come and go in one school's game rooms.

	- Bot rooms (created by School with {bots: true}): when a human walks in,
	  bots fill the room to FILL_PLAYERS so a game can start right away.
	- Regular rooms: if humans have been waiting without enough players for a
	  game (3), bots fill the room to FILL_PLAYERS after config.bots.fillDelayMs.
	- Bots never stay in a room without humans, and booted bots aren't replaced.
	- Chat: every human message gets a bot reply; at most one bot taunts per turn.
	  While people are around, bots also chat on their own every so often, and
	  sometimes answer each other (a couple of lines at most, then they wait
	  for a person to say something).
	- Each game, every bot gets a rival, spread over all players (bots included),
	  so the bots don't all pile on the one human.
*/
var _ = require('lodash');
var config = require('../config');
var brain = require('./brain');
var BotPlayer = require('./botplayer');

var FILL_PLAYERS = 5; // leaves a spot for another person
var MIN_PLAYERS = 3;
var CHAT_HISTORY = 16;
var SECOND_REPLY_CHANCE = 0.3;	// sometimes another bot chimes in too
var BOT_REPLY_CHANCE = 0.5;	// chance a bot answers another bot's line
var MAX_BOT_CHAIN = 2;		// bot-to-bot replies in a row before they wait for a person
var BANTER_QUIET_MS = 8000;	// unprompted chat only after this long without any chat
var TAUNT_CHANCE = 0.5;		// chance the turn's one taunt slot is used at all

function BotManager(school) {
	this.school = school;
	this.rooms = {}; // room id -> state (see state())
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
	if (!this.rooms[room.id]) {
		this.rooms[room.id] = {
			bots: [], fillTimer: null, booted: 0,
			chat: [], lastReply: 0, replyTimer: null, pendingMessage: null,
			lastChat: 0, botChain: 0, banterTimer: null,
			taunts: {}, rivalsFor: null
		};
	}
	return this.rooms[room.id];
};

BotManager.prototype.thinkDelay = function() {
	return config.bots.thinkDelayMs;
};

// when a bot makes her move in a turn of `seconds`: somewhere between ~8 and
// ~30 seconds into a normal 90-second turn (less in short special-rules turns),
// so a person picking her move doesn't set off the final countdown right away
BotManager.prototype.moveDelay = function(seconds) {
	if (!config.bots.paceTurns) return this.thinkDelay();
	var earliest = Math.min(8, seconds * 0.4), latest = Math.min(30, seconds * 0.7);
	return 1000 * (earliest + Math.random() * (latest - earliest));
};

BotManager.prototype.humans = function(room) {
	return room.occupants.filter(function(conn) { return !conn.isBot; });
};

BotManager.prototype.check = function(room) {
	if (this.school.games[room.id] !== room) return this.dismiss(room);
	var state = this.state(room);
	var humans = this.humans(room).length;

	if (humans === 0) return this.dismiss(room);
	this.scheduleBanter(room, state);
	if (room.game) return this.cancelFill(state);

	if (room.bots) {
		this.fill(room, FILL_PLAYERS - state.booted);
	}
	else if (room.occupants.length >= MIN_PLAYERS || state.booted > 0) {
		this.cancelFill(state);
	}
	else if (!state.fillTimer) {
		var manager = this;
		state.fillTimer = setTimeout(function() {
			state.fillTimer = null;
			if (manager.humans(room).length > 0 && !room.game && room.occupants.length < MIN_PLAYERS) {
				manager.fill(room, FILL_PLAYERS);
			}
		}, config.bots.fillDelayMs);
		state.fillTimer.unref();
	}
};

// add bots until the room has `total` players
BotManager.prototype.fill = function(room, total) {
	var state = this.state(room);
	var needed = Math.min(total, room.maxUsers) - room.occupants.length;
	for (var i = 0; i < needed; i++) {
		var taken = _.map(state.bots, 'personality');
		var bot = new BotPlayer(this, room, taken);
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
	if (state.replyTimer) clearTimeout(state.replyTimer);
	if (state.banterTimer) clearTimeout(state.banterTimer);
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


// --- game -------------------------------------------------------------------

// each bot's rival for this game, spread so every player is someone's rival
// at most about once - humans don't get singled out
BotManager.prototype.rivalOf = function(bot) {
	var room = bot.room, game = room.game;
	var state = this.rooms[room.id];
	if (!state || !game) return null;
	if (state.rivalsFor !== game) {
		state.rivalsFor = game;
		var players = _.values(game.players);
		var counts = {};
		players.forEach(function(p) { counts[p.id] = 0; });
		_.shuffle(state.bots).forEach(function(b) {
			var candidates = players.filter(function(p) { return p.id !== b.conn.user.id; });
			var fewest = _.min(candidates.map(function(p) { return counts[p.id]; }));
			var choice = _.sample(candidates.filter(function(p) { return counts[p.id] === fewest; }));
			if (choice) {
				counts[choice.id]++;
				b.rival = choice.nickname;
			}
		});
	}
	return bot.rival || null;
};

// one bot per turn may add a taunt to her move
BotManager.prototype.claimTaunt = function(bot, turn) {
	var state = this.rooms[bot.room.id];
	if (!state) return false;
	if (state.taunts.game !== bot.room.game) state.taunts = {game: bot.room.game};
	// the first bot with something to say decides this turn's slot
	if (!(turn in state.taunts)) state.taunts[turn] = Math.random() < TAUNT_CHANCE ? bot : null;
	return state.taunts[turn] === bot;
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
	state.lastChat = Date.now();
	if (data.id > 0) {
		state.botChain = 0;
		this.queueReply(bot.room, state, data);
	}
	else if (state.botChain < MAX_BOT_CHAIN && Math.random() < BOT_REPLY_CHANCE) {
		state.botChain++;
		this.queueReply(bot.room, state, data);
	}
};

// answer every human message; messages that arrive while bots are still
// answering are answered together once there's a gap
BotManager.prototype.queueReply = function(room, state, message) {
	// a person waiting for an answer takes priority over bot chatter
	if (!(state.pendingMessage && state.pendingMessage.id > 0 && message.id < 0)) state.pendingMessage = message;
	if (state.replyTimer) return;
	var manager = this;
	var wait = Math.max(0, state.lastReply + config.bots.replyGapMs - Date.now());
	state.replyTimer = setTimeout(function() {
		state.replyTimer = null;
		var pending = state.pendingMessage;
		state.pendingMessage = null;
		if (pending && manager.rooms[room.id] === state) manager.reply(room, state, pending);
	}, wait);
	state.replyTimer.unref();
};

BotManager.prototype.reply = function(room, state, message) {
	state.lastReply = Date.now();
	// bots don't answer themselves
	var bots = state.bots.filter(function(b) { return b.inRoom() && b.conn.user.id !== message.id; });
	if (!bots.length) return;
	var fromBot = message.id < 0;

	// a bot that was named answers; otherwise whoever spoke least recently
	var text = String(message.text).toLowerCase();
	var named = bots.filter(function(b) { return text.indexOf(b.nickname.toLowerCase()) !== -1; });
	var responders = named.length ? named.slice(0, fromBot ? 1 : 2) : [_.minBy(_.shuffle(bots), 'lastSpoke')];
	if (!fromBot && !named.length && bots.length > 1 && Math.random() < SECOND_REPLY_CHANCE) {
		responders.push(_.sample(_.without(bots, responders[0])));
	}

	var manager = this;
	responders.forEach(function(bot, i) {
		var gameState = bot.gameState() || manager.lobbyState(room, bot);
		brain.chatReply(bot, gameState, message).then(function(line) {
			if (line) bot.later(function() { bot.say(line); }, i * 1500);
		});
	});
};

// every so often, while people are around, a bot says something unprompted
BotManager.prototype.scheduleBanter = function(room, state) {
	if (state.banterTimer) return;
	var manager = this;
	var wait = config.bots.banterMinMs + Math.random() * (config.bots.banterMaxMs - config.bots.banterMinMs);
	state.banterTimer = setTimeout(function() {
		state.banterTimer = null;
		if (manager.rooms[room.id] !== state || manager.humans(room).length === 0) return;
		manager.scheduleBanter(room, state);
		// don't talk over a conversation that's already going
		if (Date.now() - state.lastChat < BANTER_QUIET_MS) return;
		var bot = _.sample(state.bots.filter(function(b) { return b.inRoom(); }));
		if (!bot) return;
		state.lastChat = Date.now();
		brain.banter(bot, bot.gameState() || manager.lobbyState(room, bot)).then(function(line) {
			if (line) bot.say(line);
		});
	}, wait);
	state.banterTimer.unref();
};

// what a bot knows before a game starts
BotManager.prototype.lobbyState = function(room, bot) {
	return {
		turn: 0,
		me: {nickname: bot.nickname, health: 10, lollies: 3, tattles: 2},
		others: room.occupants.filter(function(c) { return c !== bot.conn; }).map(function(c) {
			return {id: c.user.id, nickname: c.user.nickname, health: 10};
		}),
		out: [], allowed: brain.MOVES, lastTurn: [], rival: null,
		chat: this.recentChat(room)
	};
};

module.exports = BotManager;
