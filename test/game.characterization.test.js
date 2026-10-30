/*
	Characterization tests for the game engine (GameRoom + SFGame + ChatRoom).

	The snapshot in fixtures/game-digests.json was recorded from the original
	2013 code. Any change in what players see, or in recorded scores, changes
	a digest. If a change is intentional, regenerate with:
		UPDATE_SNAPSHOTS=1 npm test
	To diff a failing game, run `node test/helpers/gameHarness.js <seed>`
	on both versions.
*/
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const harness = require('./helpers/gameHarness');
const SFGame = require('../gameObjects/sfgame');

const NUM_GAMES = 400;
const SNAPSHOT = path.join(__dirname, 'fixtures/game-digests.json');

const results = [];
for (let seed = 1; seed <= NUM_GAMES; seed++) results.push(harness.playGame(seed));

test('every started game finishes', function() {
	const stuck = results.filter(function(r) { return r.turns > 0 && !r.gameOver; });
	assert.deepStrictEqual(stuck.map(function(r) { return r.seed; }), []);
});

test('turn resolution never hits the engine error handler', function() {
	// SFGame.resolveTurn swallows exceptions into a 'servererror' scene
	const broken = results.filter(function(r) { return JSON.stringify(r.log).indexOf('"servererror"') !== -1; });
	assert.deepStrictEqual(broken.map(function(r) { return r.seed; }), []);
});

test('the scripted games cover the interesting endings', function() {
	const text = results.map(function(r) { return JSON.stringify(r.log); }).join('\n');
	['became best friends', 'won the game all by herself', 'nobody won', '"booted"', '"leave"'].forEach(function(s) {
		assert.ok(text.indexOf(s) !== -1, 'no game produced ' + s);
	});
});

test('game transcripts match the recorded snapshot', function() {
	const digests = {};
	results.forEach(function(r) { digests[r.seed] = r.digest; });

	if (process.env.UPDATE_SNAPSHOTS) {
		fs.mkdirSync(path.dirname(SNAPSHOT), {recursive: true});
		fs.writeFileSync(SNAPSHOT, JSON.stringify(digests, null, 1) + '\n');
		return;
	}
	const expected = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
	const changed = Object.keys(expected).filter(function(seed) { return expected[seed] !== digests[seed]; });
	assert.deepStrictEqual(changed, [], 'transcripts changed for seeds ' + changed.slice(0, 10).join(', '));
});

test('sanitizeNewGameParams', function() {
	assert.deepStrictEqual(SFGame.sanitizeNewGameParams({}), {name: 'no name'});
	assert.deepStrictEqual(SFGame.sanitizeNewGameParams({name: 'a very long room name'}), {name: 'a very long ro'});
	assert.deepStrictEqual(
		SFGame.sanitizeNewGameParams({name: 'x', custom: {turnTime: '30', moves: {lick: 0}}}),
		{name: 'x', custom: {turnTime: '30', moves: {cower: 1, lick: 0, tattle: 1, grab: 1, scratch: 1, tease: 1}}}
	);
	// bad turn time falls back to the default
	assert.strictEqual(SFGame.sanitizeNewGameParams({name: 'x', custom: {turnTime: 45}}).custom.turnTime, SFGame.TURN_TIME);
	// disallowed combos (only cower + lick left) become a normal game
	assert.deepStrictEqual(
		SFGame.sanitizeNewGameParams({name: 'x', custom: {turnTime: 90, moves: {tattle: 0, grab: 0, scratch: 0, tease: 0}}}),
		{name: 'x'}
	);
});
