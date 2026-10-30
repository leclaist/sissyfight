/*
	gameHarness: plays deterministic, randomly-scripted games through the real
	GameRoom / SFGame code and records everything the players would see.

	Used by test/game.characterization.test.js to detect any behaviour change in
	the game engine (e.g. while upgrading lodash). To inspect one game:
		node test/helpers/gameHarness.js <seed>
*/
'use strict';

const path = require('path');
const crypto = require('crypto');

// --- deterministic randomness --------------------------------------------
// lodash captures Math.random when it loads, so install a swappable wrapper
// before anything requires it.
function mulberry32(seed) {
	let a = seed >>> 0;
	return function() {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
let engineRandom = mulberry32(1);
Math.random = function() { return engineRandom(); };

// --- stub the User model (the engine only calls User.recordScore) -------
let scoreLog = null;
const userModelPath = path.join(__dirname, '../../models/user.js');
require.cache[userModelPath] = {
	id: userModelPath, filename: userModelPath, loaded: true,
	exports: {
		recordScore: function(userID, points, win, solo) {
			if (scoreLog) scoreLog.push(['score', userID, points, !!win, !!solo]);
		}
	}
};

const GameRoom = require('../../gameObjects/gameroom');
const SFGame = require('../../gameObjects/sfgame');

const MAX_TURNS = 200;

function pick(rng, list) {
	return list[Math.floor(rng() * list.length)];
}

// Fake sockjs connection. sockjs connections stringify to a unique id, and
// GameRoom relies on that: it keys startVotes/bootVotes by connection.
function makeConn(id, rng, room, log) {
	const conn = {
		id: 'conn' + id,
		user: {
			id: id,
			nickname: 'player' + id,
			level: 1,
			avatar: {
				face: Math.floor(rng() * 8), skincolor: Math.floor(rng() * 6),
				hairstyle: Math.floor(rng() * 13), haircolor: Math.floor(rng() * 8),
				uniform: Math.floor(rng() * 5), uniformcolor: Math.floor(rng() * 6)
			}
		},
		writable: true,
		writeEvent: function(type, data) { log.push([id, type, data]); },
		end: function() { log.push([id, 'END']); },
		bootMe: function() { room.leave(conn); },
		toString: function() { return '<SockJSConnection ' + conn.id + '>'; }
	};
	return conn;
}

// Play one complete game. Scenario choices come from their own PRNG so they
// don't shift when the engine's own use of Math.random changes.
function playGame(seed) {
	const rng = mulberry32(seed * 7919 + 17);
	engineRandom = mulberry32(seed);
	const log = [];
	scoreLog = log;

	// a third of games use custom rules, run through the real sanitizer
	let custom;
	if (rng() < 0.33) {
		const moves = {};
		SFGame.MOVES.forEach(function(m) { if (rng() < 0.25) moves[m] = 0; });
		const params = SFGame.sanitizeNewGameParams({
			name: 'room' + seed,
			custom: {turnTime: pick(rng, ['15', '30', '90', '45']), moves: moves}
		});
		custom = params.custom;
		log.push(['custom', custom === undefined ? null : custom]);
	}

	const room = new GameRoom({name: 'room' + seed, id: seed, school: 'angel', custom: custom});
	let gameOver = false;
	room.on('update', function(u) { log.push(['update', u]); });

	const numPlayers = 3 + Math.floor(rng() * 4); // 3-6
	const conns = [];
	for (let i = 1; i <= numPlayers; i++) {
		const conn = makeConn(seed * 100 + i, rng, room, log);
		conns.push(conn);
		room.join(conn, function(err, info) { log.push(['joined', conn.user.id, err || info]); });
	}

	// pre-game chatter and the occasional boot vote
	conns.forEach(function(conn) {
		if (rng() < 0.3) room.say(conn, 'hi <b>everyone</b> it\'s ' + conn.user.nickname);
	});
	if (numPlayers >= 4 && rng() < 0.2) {
		const target = conns[numPlayers - 1];
		conns.slice(0, numPlayers - 1).forEach(function(conn) {
			room.act(conn, {action: 'boot', target: target.user.id});
		});
	}

	// everyone still here votes to start
	room.occupants.slice().forEach(function(conn) { room.act(conn, {action: 'start'}); });
	if (!room.game) {
		log.push(['nostart']);
		return finish(seed, log, false, 0);
	}
	room.game.on('gameOver', function() { gameOver = true; });

	const allowed = SFGame.MOVES.filter(function(m) { return !(custom && custom.moves[m] === 0); });

	let turns = 0;
	while (!gameOver && turns < MAX_TURNS) {
		turns++;
		const game = room.game;
		const players = Object.keys(game.players).map(function(k) { return game.players[k]; });
		const live = room.occupants.filter(function(conn) {
			const p = game.players[conn.user.id];
			return p && !p.loser && !p.zombie;
		});

		live.forEach(function(conn) {
			const r = rng();
			if (r < 0.03) {
				room.leave(conn); // run away mid-game
				return;
			}
			let data;
			if (r < 0.05) data = {action: 'scratch', target: conn.user.id};			// self-target
			else if (r < 0.06) data = {action: 'grab', target: 999999};				// bogus target
			else if (r < 0.07) data = {action: pick(rng, ['tease', 'cower'])};		// may be disallowed / untargeted
			else {
				const action = pick(rng, allowed);
				data = {action: action};
				if (action === 'scratch' || action === 'grab' || action === 'tease') {
					const others = players.filter(function(p) { return p.id !== conn.user.id; });
					data.target = pick(rng, others).id;
				}
			}
			if (rng() < 0.1) room.say(conn, 'take that ' + turns);
			room.act(conn, data);
		});

		// every client's turn timer runs out
		room.occupants.slice().forEach(function(conn) {
			if (room.game === game) room.act(conn, {action: 'timeout'});
		});
		if (room.game !== game && !gameOver) break;
	}

	return finish(seed, log, gameOver, turns);
}

function finish(seed, log, gameOver, turns) {
	scoreLog = null;
	const json = JSON.stringify(log);
	return {
		seed: seed,
		gameOver: gameOver,
		turns: turns,
		log: log,
		digest: crypto.createHash('sha256').update(json).digest('hex')
	};
}

// run quietly: the engine logs a lot
function quietly(fn) {
	const original = console.log;
	console.log = function() {};
	try { return fn(); }
	finally { console.log = original; }
}

module.exports = {
	playGame: function(seed) { return quietly(function() { return playGame(seed); }); }
};

if (require.main === module) {
	const result = module.exports.playGame(parseInt(process.argv[2] || '1', 10));
	process.stdout.write(JSON.stringify(result, null, 1) + '\n');
}
