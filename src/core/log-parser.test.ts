import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLine } from './log-parser';

const chat = (msg: string) => `[12:34:56] [Client thread/INFO]: [CHAT] ${msg}`;

test('ignores unrelated lines', () => {
  assert.equal(parseLine('[12:00:00] [Client thread/INFO]: Loaded 7 advancements'), null);
  assert.equal(parseLine(chat('hello everyone')), null);
  assert.equal(parseLine(chat('')), null);
});

test('server change', () => {
  assert.deepEqual(parseLine(chat('Sending you to mini121A!')), { type: 'server-change', server: 'mini121A' });
  assert.deepEqual(parseLine(chat('Sending you to lobby37!')), { type: 'server-change', server: 'lobby37' });
});

test('/who roster', () => {
  const ev = parseLine(chat('ONLINE: Alice, Bob_99, Charlie'));
  assert.deepEqual(ev, { type: 'roster', players: ['Alice', 'Bob_99', 'Charlie'] });
});

test('pre-game join with and without rank', () => {
  assert.deepEqual(parseLine(chat('Alice has joined (3/8)!')), {
    type: 'player-join',
    player: 'Alice',
    count: 3,
    max: 8,
  });
  assert.deepEqual(parseLine(chat('[MVP+] Bob_99 has joined (16/16)!')), {
    type: 'player-join',
    player: 'Bob_99',
    count: 16,
    max: 16,
  });
});

test('party join messages do not count as game joins', () => {
  assert.equal(parseLine(chat('Alice has joined the party.')), null);
});

test('quit', () => {
  assert.deepEqual(parseLine(chat('[VIP] Alice has quit!')), { type: 'player-quit', player: 'Alice' });
});

test('game start', () => {
  assert.deepEqual(parseLine(chat('Protect your bed and destroy the enemy beds.')), { type: 'game-start' });
});

test('final kill extracts the victim', () => {
  assert.deepEqual(parseLine(chat('Alice was knocked into the void by Bob_99. FINAL KILL!')), {
    type: 'final-kill',
    victim: 'Alice',
  });
  assert.equal(parseLine(chat('Alice was killed by Bob_99.')), null);
});

test('disconnect / reconnect', () => {
  assert.deepEqual(parseLine(chat('Alice disconnected.')), { type: 'disconnect', player: 'Alice' });
  assert.deepEqual(parseLine(chat('Alice reconnected.')), { type: 'reconnect', player: 'Alice' });
});

test('self name from launcher line', () => {
  assert.deepEqual(parseLine('[12:00:00] [main/INFO]: Setting user: MyName'), { type: 'self-name', name: 'MyName' });
});

test('strips colour codes and tolerates other thread names', () => {
  const lunar = '[12:34:56] [Render thread/INFO]: [CHAT] §a§lONLINE: §rAlice, Bob';
  assert.deepEqual(parseLine(lunar), { type: 'roster', players: ['Alice', 'Bob'] });
});
