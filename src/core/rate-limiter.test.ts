import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestQueue } from './rate-limiter';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('runs tasks in order and resolves their results', async () => {
  const q = new RequestQueue({ ratePerSecond: 1000, burst: 10, concurrency: 1 });
  const order: number[] = [];
  const results = await Promise.all(
    [1, 2, 3].map((n) =>
      q.schedule(async () => {
        order.push(n);
        return n * 10;
      }),
    ),
  );
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(results, [10, 20, 30]);
  assert.equal(q.length, 0);
  assert.equal(q.inFlight, 0);
});

test('rejections propagate without stalling the queue', async () => {
  const q = new RequestQueue({ ratePerSecond: 1000, burst: 10 });
  await assert.rejects(q.schedule(async () => Promise.reject(new Error('boom'))), /boom/);
  assert.equal(await q.schedule(async () => 'ok'), 'ok');
});

test('token bucket throttles beyond the burst', async () => {
  const q = new RequestQueue({ ratePerSecond: 20, burst: 2, concurrency: 10 });
  const started: number[] = [];
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: 4 }, () =>
      q.schedule(async () => {
        started.push(Date.now() - t0);
      }),
    ),
  );
  // first two immediately, the next two need ~50 ms each of refill
  assert.ok(started[0] < 30 && started[1] < 30, `burst should be instant: ${started}`);
  assert.ok(started[2] >= 35, `third should wait for a token: ${started}`);
  assert.ok(started[3] >= 80, `fourth should wait longer: ${started}`);
});

test('concurrency limit holds', async () => {
  const q = new RequestQueue({ ratePerSecond: 1000, burst: 10, concurrency: 2 });
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      q.schedule(async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(10);
        active--;
      }),
    ),
  );
  assert.equal(peak, 2);
});

test('pause delays dispatch', async () => {
  const q = new RequestQueue({ ratePerSecond: 1000, burst: 10 });
  q.pause(80);
  assert.equal(q.isPaused, true);
  const t0 = Date.now();
  await q.schedule(async () => undefined);
  assert.ok(Date.now() - t0 >= 70, 'task ran before the pause ended');
});

test('clear drops tasks that have not started', async () => {
  const q = new RequestQueue({ ratePerSecond: 1000, burst: 10 });
  q.pause(50);
  let ran = false;
  void q.schedule(async () => {
    ran = true;
  });
  q.clear();
  await sleep(80);
  assert.equal(ran, false);
  assert.equal(q.length, 0);
});
