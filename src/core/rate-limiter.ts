/**
 * Token-bucket rate limiter with an asynchronous work queue.
 *
 * Every scheduled task consumes one token before it runs. Tokens refill at
 * `ratePerSecond` up to `burst`. At most `concurrency` tasks run at once.
 * `pause()` stops dispatching for a while: the Hypixel client calls it when
 * the API's RateLimit-Remaining header gets low or a 429 comes back, so the
 * overlay backs off before it can be penalised.
 */

export interface RequestQueueOptions {
  ratePerSecond: number;
  burst: number;
  /** Tasks allowed in flight at once. Default 4. */
  concurrency?: number;
  /** Clock, injectable for tests. Default Date.now. */
  now?: () => number;
}

type Runner = () => Promise<void>;

export class RequestQueue {
  private readonly rate: number;
  private readonly burst: number;
  private readonly concurrency: number;
  private readonly now: () => number;

  private tokens: number;
  private lastRefill: number;
  private pausedUntil = 0;
  private active = 0;
  private readonly pending: Runner[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: RequestQueueOptions) {
    if (opts.ratePerSecond <= 0) throw new RangeError('ratePerSecond must be > 0');
    if (opts.burst < 1) throw new RangeError('burst must be >= 1');
    this.rate = opts.ratePerSecond;
    this.burst = opts.burst;
    this.concurrency = opts.concurrency ?? 4;
    this.now = opts.now ?? Date.now;
    this.tokens = this.burst;
    this.lastRefill = this.now();
  }

  /** Tasks waiting for a slot or a token. */
  get length(): number {
    return this.pending.length;
  }

  /** Tasks currently running. */
  get inFlight(): number {
    return this.active;
  }

  get isPaused(): boolean {
    return this.now() < this.pausedUntil;
  }

  /** Queues `fn` and resolves with its result once it has run. */
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push(async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        } finally {
          this.active--;
          this.pump();
        }
      });
      this.pump();
    });
  }

  /** Stops dispatching new tasks for `ms` milliseconds (extends an existing pause, never shortens it). */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + Math.max(0, ms));
    this.rearm();
  }

  /** Rejects nothing, simply forgets tasks that have not started yet. */
  clear(): void {
    this.pending.length = 0;
  }

  private refill(): void {
    const t = this.now();
    const elapsed = (t - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
      this.lastRefill = t;
    }
  }

  private rearm(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pump();
  }

  private pump(): void {
    if (this.timer) return;
    while (this.pending.length && this.active < this.concurrency) {
      const t = this.now();
      if (t < this.pausedUntil) {
        this.wakeIn(this.pausedUntil - t);
        return;
      }
      this.refill();
      if (this.tokens < 1) {
        this.wakeIn(Math.ceil(((1 - this.tokens) / this.rate) * 1000));
        return;
      }
      this.tokens -= 1;
      this.active++;
      const task = this.pending.shift()!;
      void task();
    }
  }

  private wakeIn(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(1, ms));
    // Do not keep the process alive just for a pending wake-up.
    this.timer.unref?.();
  }
}
