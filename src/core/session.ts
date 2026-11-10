/**
 * Game-session state: who is in the current game, and what we know about them.
 *
 * The tracker consumes LogEvents, keeps a roster of PlayerRows, and resolves
 * each player through two caches (name -> uuid, uuid -> stats) before it ever
 * touches the network. A player seen in a previous game within the stats TTL
 * costs zero API calls.
 */
import { EventEmitter } from 'node:events';
import type { BedwarsStats, PlayerRow } from '../shared/types';
import { extractBedwarsStats, rankOf, threatLevel } from './bedwars-stats';
import { TtlLruCache, type CacheJson } from './cache';
import { HypixelApiError, type HypixelClient } from './hypixel';
import type { LogEvent } from './log-parser';
import type { ResolvedProfile } from './mojang';

export interface CachedStats {
  stats: BedwarsStats;
  rank: string | null;
  name: string;
}

export interface CachedProfile {
  /** null means Mojang has no such account: the name is a nick. */
  uuid: string | null;
  name: string;
}

export interface TrackerOptions {
  hypixel: HypixelClient;
  resolveProfile: (name: string) => Promise<ResolvedProfile | null>;
  /** Default 30 minutes. */
  statsTtlMs?: number;
  /** Default 24 hours. UUIDs never change, but names can be transferred. */
  uuidTtlMs?: number;
  /** How long to remember that a name is a nick. Default 10 minutes. */
  nickTtlMs?: number;
  maxCacheEntries?: number;
  now?: () => number;
}

export interface TrackerCaches {
  stats: CacheJson<CachedStats>;
  uuids: CacheJson<CachedProfile>;
}

export interface TrackerEvents {
  update: [rows: PlayerRow[]];
  /** Something the user should see (bad key, API down, ...). */
  notice: [message: string];
}

const key = (name: string) => name.toLowerCase();

export class PlayerTracker extends EventEmitter<TrackerEvents> {
  readonly statsCache: TtlLruCache<CachedStats>;
  readonly uuidCache: TtlLruCache<CachedProfile>;

  private readonly hypixel: HypixelClient;
  private readonly resolveProfile: TrackerOptions['resolveProfile'];
  private readonly nickTtlMs: number;
  private readonly now: () => number;

  private readonly roster = new Map<string, PlayerRow>();
  private selfName: string | null = null;
  /** Bumped on reset/refresh so in-flight lookups from before are discarded. */
  private generation = 0;

  constructor(opts: TrackerOptions) {
    super();
    this.hypixel = opts.hypixel;
    this.resolveProfile = opts.resolveProfile;
    this.nickTtlMs = opts.nickTtlMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
    const max = opts.maxCacheEntries ?? 2000;
    this.statsCache = new TtlLruCache<CachedStats>(opts.statsTtlMs ?? 30 * 60_000, max, this.now);
    this.uuidCache = new TtlLruCache<CachedProfile>(opts.uuidTtlMs ?? 24 * 60 * 60_000, max * 2, this.now);
  }

  get size(): number {
    return this.roster.size;
  }

  /** Current rows, in the order players were seen. */
  snapshot(): PlayerRow[] {
    return [...this.roster.values()].map((r) => ({ ...r }));
  }

  handleEvent(ev: LogEvent): void {
    switch (ev.type) {
      case 'self-name': {
        this.selfName = ev.name;
        const row = this.roster.get(key(ev.name));
        if (row) {
          row.self = true;
          this.emitUpdate();
        }
        break;
      }
      case 'server-change':
        this.reset();
        break;
      case 'roster': {
        const keep = new Set(ev.players.map(key));
        for (const k of [...this.roster.keys()]) {
          if (!keep.has(k)) this.roster.delete(k);
        }
        for (const p of ev.players) this.add(p);
        this.emitUpdate();
        break;
      }
      case 'player-join':
        this.add(ev.player);
        break;
      case 'player-quit':
        if (this.roster.delete(key(ev.player))) this.emitUpdate();
        break;
      case 'game-start':
        for (const row of this.roster.values()) {
          row.alive = true;
          row.connected = true;
        }
        this.emitUpdate();
        break;
      case 'final-kill':
        this.patch(ev.victim, (r) => (r.alive = false));
        break;
      case 'disconnect':
        this.patch(ev.player, (r) => (r.connected = false));
        break;
      case 'reconnect':
        this.patch(ev.player, (r) => (r.connected = true));
        break;
    }
  }

  /** Adds a player to the roster and starts resolving them (no-op if already present). */
  add(name: string): void {
    const k = key(name);
    if (this.roster.has(k)) return;
    const row: PlayerRow = {
      name,
      threat: 'unknown',
      state: 'loading',
      alive: true,
      connected: true,
      fromCache: false,
      self: this.selfName !== null && key(this.selfName) === k,
      updatedAt: this.now(),
    };
    this.roster.set(k, row);
    this.emitUpdate();
    void this.lookup(row, false);
  }

  /** Clears the roster (caches are kept). */
  reset(): void {
    this.generation++;
    this.roster.clear();
    this.emitUpdate();
  }

  /** Re-fetches every player in the roster, bypassing the stats cache. */
  refresh(): void {
    this.generation++;
    for (const row of this.roster.values()) {
      row.state = 'loading';
      row.error = undefined;
      row.updatedAt = this.now();
      void this.lookup(row, true);
    }
    this.emitUpdate();
  }

  exportCaches(): TrackerCaches {
    return { stats: this.statsCache.toJSON(), uuids: this.uuidCache.toJSON() };
  }

  importCaches(json: Partial<TrackerCaches> | null | undefined): void {
    if (!json) return;
    this.statsCache.load(json.stats);
    this.uuidCache.load(json.uuids);
  }

  private patch(name: string, fn: (row: PlayerRow) => void): void {
    const row = this.roster.get(key(name));
    if (!row) return;
    fn(row);
    row.updatedAt = this.now();
    this.emitUpdate();
  }

  private emitUpdate(): void {
    this.emit('update', this.snapshot());
  }

  private async lookup(row: PlayerRow, force: boolean): Promise<void> {
    const gen = this.generation;
    const k = key(row.name);
    const stillRelevant = () => this.generation === gen && this.roster.get(k) === row;

    try {
      let profile = force ? undefined : this.uuidCache.get(k);
      if (!profile) {
        const resolved = await this.resolveProfile(row.name);
        profile = { uuid: resolved?.uuid ?? null, name: resolved?.name ?? row.name };
        this.uuidCache.set(k, profile, profile.uuid ? undefined : this.nickTtlMs);
      }
      if (!stillRelevant()) return;

      if (!profile.uuid) {
        row.state = 'nick';
        row.threat = 'nick';
        row.updatedAt = this.now();
        this.emitUpdate();
        return;
      }
      row.uuid = profile.uuid;
      row.name = profile.name;

      let cached = force ? undefined : this.statsCache.get(profile.uuid);
      const fromCache = cached !== undefined;
      if (!cached) {
        const player = await this.hypixel.getPlayer(profile.uuid);
        if (!stillRelevant()) return;
        if (!player) {
          row.state = 'never-played';
          row.threat = 'unknown';
          row.updatedAt = this.now();
          this.emitUpdate();
          return;
        }
        cached = {
          stats: extractBedwarsStats(player),
          rank: rankOf(player),
          name: player.displayname ?? profile.name,
        };
        this.statsCache.set(profile.uuid, cached);
      }

      row.name = cached.name;
      row.stats = cached.stats;
      row.rank = cached.rank;
      row.threat = threatLevel(cached.stats);
      row.state = 'ready';
      row.fromCache = fromCache;
      row.error = undefined;
      row.updatedAt = this.now();
      this.emitUpdate();
    } catch (err) {
      if (!stillRelevant()) return;
      const message = err instanceof Error ? err.message : String(err);
      row.state = 'error';
      row.error = message;
      row.threat = 'unknown';
      row.updatedAt = this.now();
      this.emitUpdate();
      if (err instanceof HypixelApiError && (err.status === 403 || err.status === 0 || err.status === 429)) {
        this.emit('notice', message);
      }
    }
  }
}
