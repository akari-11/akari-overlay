import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HypixelApiError, HypixelClient } from './hypixel';
import { RequestQueue } from './rate-limiter';

type Call = { url: string; headers: Record<string, string> };

function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers,
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const queue = () => new RequestQueue({ ratePerSecond: 1000, burst: 10 });

test('sends the API-Key header and returns the player', async () => {
  const { fetchImpl, calls } = fakeFetch([
    {
      status: 200,
      body: { success: true, player: { displayname: 'Alice' } },
      headers: { 'RateLimit-Limit': '300', 'RateLimit-Remaining': '299', 'RateLimit-Reset': '240' },
    },
  ]);
  const client = new HypixelClient({ apiKey: 'secret', queue: queue(), fetchImpl });
  const player = await client.getPlayer('abc');
  assert.deepEqual(player, { displayname: 'Alice' });
  assert.equal(calls[0].headers['API-Key'], 'secret');
  assert.match(calls[0].url, /\/v2\/player\?uuid=abc$/);
  assert.equal(client.rateRemaining, 299);
  assert.equal(client.rateLimit, 300);
});

test('null player for accounts that never joined', async () => {
  const { fetchImpl } = fakeFetch([{ status: 200, body: { success: true, player: null } }]);
  const client = new HypixelClient({ apiKey: 'k', queue: queue(), fetchImpl });
  assert.equal(await client.getPlayer('abc'), null);
});

test('rejects without a key, without touching the network', async () => {
  const { fetchImpl, calls } = fakeFetch([]);
  const client = new HypixelClient({ apiKey: '', queue: queue(), fetchImpl });
  await assert.rejects(client.getPlayer('abc'), (e: unknown) => e instanceof HypixelApiError && e.status === 0);
  assert.equal(calls.length, 0);
});

test('403 surfaces as an invalid key error', async () => {
  const { fetchImpl } = fakeFetch([{ status: 403, body: { success: false, cause: 'Invalid API key' } }]);
  const client = new HypixelClient({ apiKey: 'bad', queue: queue(), fetchImpl });
  await assert.rejects(client.getPlayer('abc'), (e: unknown) => e instanceof HypixelApiError && e.status === 403);
});

test('429 pauses the queue, waits, then retries once', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { status: 429, headers: { 'Retry-After': '2' } },
    { status: 200, body: { success: true, player: { displayname: 'Alice' } } },
  ]);
  const q = queue();
  const slept: number[] = [];
  const client = new HypixelClient({
    apiKey: 'k',
    queue: q,
    fetchImpl,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  const player = await client.getPlayer('abc');
  assert.deepEqual(player, { displayname: 'Alice' });
  assert.equal(calls.length, 2);
  assert.deepEqual(slept, [2000]);
  assert.equal(q.isPaused, true);
});

test('low RateLimit-Remaining pauses the queue pre-emptively', async () => {
  const { fetchImpl } = fakeFetch([
    {
      status: 200,
      body: { success: true, player: {} },
      headers: { 'RateLimit-Remaining': '2', 'RateLimit-Reset': '30' },
    },
  ]);
  const q = queue();
  const client = new HypixelClient({ apiKey: 'k', queue: q, fetchImpl, lowWaterMark: 5 });
  await client.getPlayer('abc');
  assert.equal(q.isPaused, true);
});
