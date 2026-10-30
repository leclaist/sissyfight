/*
	BotPlayer: a computer-controlled player that sits in a game room like a
	browser connection does. GameRoom/SFGame can't tell the difference: the bot
	gets the same events through writeEvent and answers with room.act/room.say.
*/
var _ = require('lodash');
var brain = require('./brain');

// "Robo" names are reserved (see User.checkNicknameAndEmail), so bots are
// always recognizable and can't be impersonated
var NAMES = ['RoboBecky', 'RoboTiffany', 'RoboMadison', 'RoboKayla', 'RoboBrittany', 'RoboAmber',
	'RoboJessica', 'RoboHeather', 'RoboAshley', 'RoboCrystal', 'RoboStacy', 'RoboDestiny'];

var PERSONALITIES = [
	"sweet as pie in chat, but secretly schemes to be the last girl standing",
	"loud, bossy playground queen who loves organizing group teases",
	"nervous goody-two-shoes who cowers a lot and hates tattlers",
	"total drama queen who takes every scratch personally and swears revenge",
	"smug know-it-all who explains strategy to everyone, whether they asked or not",
	"chaotic gremlin who does unpredictable things just to see what happens",
	"loyal friend who sticks with whoever is nicest to her in chat",
	"sarcastic and unbothered, with one-word comebacks",
	"gossip who spreads rumors about who's secretly planning to tattle",
	"overly competitive teacher's pet who keeps score of everything",
	"dreamy space cadet who misreads the room but is weirdly lucky",
	"fake-nice politician who promises alliances to everyone"
];

var nextId = 1;

// takenPersonalities: personalities already used in this room, so each bot is different
function BotPlayer(manager, room, takenPersonalities) {
	var id = -(nextId++); // negative ids: never a real user, never ranked
	var taken = room.getOccupantNicknames();
	var name = _.sample(_.difference(NAMES, taken)) || ('Robo' + (-id));

	this.manager = manager;
	this.room = room;
	this.nickname = name;
	this.personality = _.sample(_.difference(PERSONALITIES, takenPersonalities || [])) || _.sample(PERSONALITIES);
	this.rival = null;
	this.lastSpoke = 0;
	this.turn = 0;
	this.lastTurn = [];
	this.gone = false;

	var bot = this;
	this.conn = {
		id: 'bot' + (-id),
		isBot: true,
		writable: true,
		user: {
			id: id,
			nickname: name,
			level: 1,
			avatar: {
				face: _.random(0, 7), skincolor: _.random(0, 5), hairstyle: _.random(0, 12),
				haircolor: _.random(0, 7), uniform: _.random(0, 4), uniformcolor: 0, addons: []
			}
		},
		writeEvent: function(type, data) { bot.handleEvent(type, data); },
		end: function() { bot.leave(); },
		bootMe: function() { bot.manager.booted(bot); bot.leave(); },
		toString: function() { return '<Bot ' + id + '>'; }
	};
	// bots never go stale, so GameRoom.ping never kicks them
	Object.defineProperty(this.conn, 'pingTime', {get: function() { return Date.now(); }, set: function() {}});
}

BotPlayer.prototype.join = function() {
	var bot = this, joined = false;
	this.room.join(this.conn, function(err) {
		if (err) return;
		joined = true;
		bot.later(function() { bot.pressStart(); });
	});
	return joined;
};

BotPlayer.prototype.inRoom = function() {
	return !this.gone && this.room.occupants.indexOf(this.conn) !== -1;
};

BotPlayer.prototype.leave = function() {
	if (this.gone) return;
	this.gone = true;
	if (this.room.occupants.indexOf(this.conn) !== -1) this.room.leave(this.conn);
	this.manager.forget(this);
};

BotPlayer.prototype.later = function(fn, extra) {
	var bot = this;
	setTimeout(function() { if (bot.inRoom()) fn(); }, this.manager.thinkDelay() + (extra || 0)).unref();
};

BotPlayer.prototype.pressStart = function() {
	if (!this.room.game) this.room.act(this.conn, {action: 'start'});
};

BotPlayer.prototype.say = function(text) {
	if (!text || !this.inRoom()) return;
	this.lastSpoke = Date.now();
	this.room.say(this.conn, text);
};


BotPlayer.prototype.handleEvent = function(type, data) {
	if (this.gone) return;
	if (type === 'say') {
		this.manager.chatSeen(this, data);
	}
	else if (type === 'gameEvent') {
		switch (data.event) {
			case 'startGame':
				this.turn = 0;
				this.lastTurn = [];
				this.rival = null;
				break;
			case 'startTurn':
				this.turn++;
				// the first turn starts inside SFGame's constructor, before GameRoom
				// has stored the game in room.game, so wait a tick
				setImmediate(this.playTurn.bind(this, this.turn, data.time));
				break;
			case 'endTurn':
				this.lastTurn = _.compact(_.map(data.results, 'text'));
				break;
			case 'endGame':
				// stay for a rematch if there are still humans to play with
				var bot = this;
				this.later(function() { bot.pressStart(); }, 5000);
				break;
		}
	}
};


// what the bot knows about the game right now, for the brain
BotPlayer.prototype.gameState = function() {
	var game = this.room.game;
	var me = game && game.players[this.conn.user.id];
	if (!me) return null;
	var players = _.values(game.players);
	var custom = game.custom;
	return {
		turn: this.turn,
		me: {nickname: this.nickname, health: me.health, lollies: me.lollies, tattles: me.tattles},
		// who's a bot is left out on purpose: bots treat everyone the same
		others: players.filter(function(p) { return p.id !== me.id && !p.loser && !p.zombie; }).map(function(p) {
			return {id: p.id, nickname: p.nickname, health: p.health};
		}),
		rival: this.manager.rivalOf(this),
		out: _.map(players.filter(function(p) { return p.loser; }), 'nickname'),
		allowed: brain.MOVES.filter(function(m) { return !(custom && custom.moves && custom.moves[m] == 0); }),
		lastTurn: this.lastTurn,
		chat: this.manager.recentChat(this.room)
	};
};

// seconds: length of the turn
BotPlayer.prototype.playTurn = function(turn, seconds) {
	var bot = this, game = this.room.game;
	var state = this.gameState();
	if (!state) return; // out of the game
	var me = game.players[this.conn.user.id];
	if (me.loser || me.zombie) return;

	var started = Date.now();
	var delay = this.manager.moveDelay(seconds || 90);
	brain.decideMove(this, state).then(function(move) {
		// decide right away, but make the move later in the turn, like a person would
		var wait = Math.max(0, delay - (Date.now() - started));
		setTimeout(function() {
			if (!bot.inRoom() || bot.room.game !== game || bot.turn !== turn) return;
			bot.room.act(bot.conn, {action: move.action, target: move.target});
			if (move.say && bot.manager.claimTaunt(bot, turn)) bot.say(move.say);
			bot.room.act(bot.conn, {action: 'timeout'});
		}, wait).unref();
	});
};

module.exports = BotPlayer;
