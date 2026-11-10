/**
 * Tails a log file the way `tail -f` does, cheaply.
 *
 * The watcher never keeps the file open. Every `pollIntervalMs` it stats the
 * file and, only if it grew, opens it, reads the new bytes from the last
 * known offset and closes it again. Idle cost is one stat() call per poll,
 * which is invisible on CPU graphs. Truncation and log rotation (file shrinks
 * or disappears and comes back) reset the offset automatically.
 */
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export interface LogWatcherOptions {
  /** How often to check the file for growth. Default 250 ms. */
  pollIntervalMs?: number;
  /** Replay the whole file on start instead of starting at the end. Default false. */
  fromStart?: boolean;
  /** Maximum bytes read per poll, to bound memory on huge bursts. Default 1 MiB. */
  maxChunkBytes?: number;
}

export interface LogWatcherEvents {
  line: [line: string];
  missing: [];
  found: [];
  truncated: [];
  error: [err: Error];
}

export class LogWatcher extends EventEmitter<LogWatcherEvents> {
  private readonly pollMs: number;
  private readonly fromStart: boolean;
  private readonly maxChunk: number;

  /** Byte offset of the next unread byte. -1 means "unknown, decide on first stat". */
  private pos = -1;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private missing = false;
  private decoder = new StringDecoder('utf8');
  private remainder = '';

  constructor(
    public readonly filePath: string,
    opts: LogWatcherOptions = {},
  ) {
    super();
    this.pollMs = opts.pollIntervalMs ?? 250;
    this.fromStart = opts.fromStart ?? false;
    this.maxChunk = opts.maxChunkBytes ?? 1024 * 1024;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isMissing(): boolean {
    return this.missing;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pos = -1;
    this.remainder = '';
    this.decoder = new StringDecoder('utf8');
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), this.pollMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const st = await fs.stat(this.filePath);
      if (this.missing) {
        this.missing = false;
        this.emit('found');
      }
      if (this.pos < 0) this.pos = this.fromStart ? 0 : st.size;
      if (st.size < this.pos) {
        // Truncated or rotated in place: start over.
        this.pos = 0;
        this.remainder = '';
        this.emit('truncated');
      }
      if (st.size > this.pos) await this.readRange(this.pos, st.size);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        if (!this.missing) {
          this.missing = true;
          this.emit('missing');
        }
        // When the file is recreated (client restart) read it from the beginning.
        this.pos = 0;
        this.remainder = '';
      } else {
        this.emit('error', e);
      }
    } finally {
      this.schedule();
    }
  }

  private async readRange(start: number, end: number): Promise<void> {
    const fh = await fs.open(this.filePath, 'r');
    try {
      let cursor = start;
      while (cursor < end && this.running) {
        const len = Math.min(this.maxChunk, end - cursor);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, cursor);
        if (bytesRead === 0) break;
        cursor += bytesRead;
        this.pos = cursor;
        this.pushText(this.decoder.write(buf.subarray(0, bytesRead)));
      }
    } finally {
      await fh.close();
    }
  }

  private pushText(text: string): void {
    const chunk = this.remainder + text;
    const lines = chunk.split(/\r?\n/);
    this.remainder = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length) this.emit('line', line);
    }
  }
}
