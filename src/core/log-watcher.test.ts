import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { LogWatcher } from './log-watcher';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}

async function tmpLog(initial = ''): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'akari-log-'));
  const file = path.join(dir, 'latest.log');
  await fs.writeFile(file, initial);
  return file;
}

test('emits only lines appended after start', async () => {
  const file = await tmpLog('old line 1\nold line 2\n');
  const w = new LogWatcher(file, { pollIntervalMs: 20 });
  const lines: string[] = [];
  w.on('line', (l) => lines.push(l));
  w.start();
  try {
    await sleep(50);
    await fs.appendFile(file, 'new line\r\nanother\n');
    await waitFor(() => lines.length >= 2);
    assert.deepEqual(lines, ['new line', 'another']);
  } finally {
    w.stop();
  }
});

test('buffers partial lines until the newline arrives', async () => {
  const file = await tmpLog();
  const w = new LogWatcher(file, { pollIntervalMs: 20 });
  const lines: string[] = [];
  w.on('line', (l) => lines.push(l));
  w.start();
  try {
    await sleep(40);
    await fs.appendFile(file, 'half');
    await sleep(60);
    assert.deepEqual(lines, []);
    await fs.appendFile(file, ' done\n');
    await waitFor(() => lines.length === 1);
    assert.deepEqual(lines, ['half done']);
  } finally {
    w.stop();
  }
});

test('fromStart replays existing content', async () => {
  const file = await tmpLog('a\nb\n');
  const w = new LogWatcher(file, { pollIntervalMs: 20, fromStart: true });
  const lines: string[] = [];
  w.on('line', (l) => lines.push(l));
  w.start();
  try {
    await waitFor(() => lines.length === 2);
    assert.deepEqual(lines, ['a', 'b']);
  } finally {
    w.stop();
  }
});

test('recovers from truncation', async () => {
  const file = await tmpLog('x'.repeat(100) + '\n');
  const w = new LogWatcher(file, { pollIntervalMs: 20 });
  const lines: string[] = [];
  let truncated = 0;
  w.on('line', (l) => lines.push(l));
  w.on('truncated', () => truncated++);
  w.start();
  try {
    await sleep(40);
    await fs.writeFile(file, 'fresh\n'); // shorter than before
    await waitFor(() => lines.length === 1);
    assert.deepEqual(lines, ['fresh']);
    assert.equal(truncated, 1);
  } finally {
    w.stop();
  }
});

test('reports a missing file and picks it up once created', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'akari-log-'));
  const file = path.join(dir, 'latest.log');
  const w = new LogWatcher(file, { pollIntervalMs: 20 });
  const lines: string[] = [];
  let missing = 0;
  let found = 0;
  w.on('line', (l) => lines.push(l));
  w.on('missing', () => missing++);
  w.on('found', () => found++);
  w.start();
  try {
    await waitFor(() => missing === 1);
    assert.equal(w.isMissing, true);
    await fs.writeFile(file, 'created\n');
    await waitFor(() => lines.length === 1);
    assert.equal(found, 1);
    assert.equal(w.isMissing, false);
    assert.deepEqual(lines, ['created']);
  } finally {
    w.stop();
  }
});
