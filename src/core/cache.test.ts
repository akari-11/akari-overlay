import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TtlLruCache } from './cache';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

test('stores and expires entries', () => {
  const c = clock();
  const cache = new TtlLruCache<number>(1000, 10, c.now);
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  c.tick(999);
  assert.equal(cache.get('a'), 1);
  c.tick(1);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 0);
});

test('per-entry ttl override', () => {
  const c = clock();
  const cache = new TtlLruCache<string>(60_000, 10, c.now);
  cache.set('nick', 'x', 100);
  c.tick(101);
  assert.equal(cache.get('nick'), undefined);
});

test('evicts least recently used when full', () => {
  const c = clock();
  const cache = new TtlLruCache<number>(60_000, 3, c.now);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  cache.get('a'); // a is now most recent
  cache.set('d', 4); // evicts b
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.get('d'), 4);
});

test('round-trips through JSON and drops expired entries on load', () => {
  const c = clock();
  const cache = new TtlLruCache<number>(1000, 10, c.now);
  cache.set('fresh', 1);
  cache.set('stale', 2, 10);
  const json = JSON.parse(JSON.stringify(cache.toJSON()));

  c.tick(500);
  const restored = new TtlLruCache<number>(1000, 10, c.now);
  assert.equal(restored.load(json), 1);
  assert.equal(restored.get('fresh'), 1);
  assert.equal(restored.get('stale'), undefined);
});

test('load ignores garbage', () => {
  const cache = new TtlLruCache<number>(1000, 10);
  assert.equal(cache.load(null), 0);
  assert.equal(cache.load({ ttlMs: 1, entries: [['x', { value: 1, expiresAt: 'nope' } as never], 'junk' as never] }), 0);
});

test('prune removes expired entries', () => {
  const c = clock();
  const cache = new TtlLruCache<number>(100, 10, c.now);
  cache.set('a', 1);
  cache.set('b', 2, 1000);
  c.tick(200);
  assert.equal(cache.prune(), 1);
  assert.equal(cache.size, 1);
});
