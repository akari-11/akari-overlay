/**
 * Minimal Hypixel Public API v2 client for the `/player` endpoint.
 *
 * All calls go through a RequestQueue so the overlay never exceeds the key's
 * limit. The client also reads Hypixel's RateLimit-* response headers and
 * pauses the queue pre-emptively when the remaining budget gets low, and
 * backs off (then retries once) on HTTP 429.
 */
import type { HypixelPlayer } from './bedwars-stats';
import type { RequestQueue } from './rate-limiter';

export interface HypixelClientOptions {
  apiKey: string;
  queue: RequestQueue;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  userAgent?: string;
  /** Pause the queue when RateLimit-Remaining drops to this value. Default 5. */
  lowWaterMark?: number;
  /** Sleep implementation, injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class HypixelApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'HypixelApiError';
  }
}

interface PlayerResponse {
  success: boolean;
  cause?: string;
  player?: HypixelPlayer | null;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HypixelClient {
  private apiKey: string;
  private readonly queue: RequestQueue;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly lowWaterMark: number;
  private readonly sleep: (ms: number) => Promise<void>;

  private remaining: number | null = null;
  private limit: number | null = null;

  constructor(opts: HypixelClientOptions) {
    this.apiKey = opts.apiKey;
    this.queue = opts.queue;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = (opts.baseUrl ?? 'https://api.hypixel.net').replace(/\/$/, '');
    this.userAgent = opts.userAgent ?? 'akari-overlay (https://github.com/akari-11/akari-overlay)';
    this.lowWaterMark = opts.lowWaterMark ?? 5;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  setApiKey(key: string): void {
    this.apiKey = key.trim();
    this.remaining = null;
    this.limit = null;
  }

  get hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  /** Last RateLimit-Remaining value Hypixel reported, if any. */
  get rateRemaining(): number | null {
    return this.remaining;
  }

  get rateLimit(): number | null {
    return this.limit;
  }

  /**
   * Fetches a player by undashed UUID. Resolves to null for accounts that have
   * never joined Hypixel. Rejects with HypixelApiError on key / API problems.
   */
  getPlayer(uuid: string): Promise<HypixelPlayer | null> {
    if (!this.hasApiKey) {
      return Promise.reject(new HypixelApiError('No Hypixel API key configured', 0));
    }
    return this.queue.schedule(() => this.request(uuid));
  }

  private async request(uuid: string, attempt = 0): Promise<HypixelPlayer | null> {
    const url = `${this.baseUrl}/v2/player?uuid=${encodeURIComponent(uuid)}`;
    const res = await this.fetchImpl(url, {
      headers: { 'API-Key': this.apiKey, 'User-Agent': this.userAgent, Accept: 'application/json' },
    });
    this.readRateHeaders(res);

    if (res.status === 429) {
      const waitSec = this.retryAfterSeconds(res) ?? 10;
      this.queue.pause(waitSec * 1000);
      if (attempt < 1) {
        await this.sleep(waitSec * 1000);
        return this.request(uuid, attempt + 1);
      }
      throw new HypixelApiError('Hypixel API rate limit hit; backing off', 429);
    }
    if (res.status === 403) throw new HypixelApiError('Hypixel API key is invalid or expired', 403);
    if (res.status === 400) throw new HypixelApiError('Hypixel rejected the request (bad UUID?)', 400);
    if (!res.ok) throw new HypixelApiError(`Hypixel API HTTP ${res.status}`, res.status);

    const body = (await res.json()) as PlayerResponse;
    if (!body.success) throw new HypixelApiError(body.cause ?? 'Hypixel API returned success=false', res.status);
    return body.player ?? null;
  }

  private readRateHeaders(res: Response): void {
    const rem = Number(res.headers.get('ratelimit-remaining'));
    const lim = Number(res.headers.get('ratelimit-limit'));
    const reset = Number(res.headers.get('ratelimit-reset'));
    if (Number.isFinite(lim) && res.headers.has('ratelimit-limit')) this.limit = lim;
    if (Number.isFinite(rem) && res.headers.has('ratelimit-remaining')) {
      this.remaining = rem;
      if (rem <= this.lowWaterMark && Number.isFinite(reset) && reset > 0) {
        this.queue.pause(reset * 1000 + 500);
      }
    }
  }

  private retryAfterSeconds(res: Response): number | null {
    const retry = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retry) && retry > 0) return retry;
    const reset = Number(res.headers.get('ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return reset;
    return null;
  }
}
