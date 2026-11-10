/**
 * Types shared between the main process, the core modules and the renderer.
 * The renderer references this file through `import('../shared/types')` type
 * queries only, so nothing here may have runtime side effects.
 */

export interface BedwarsStats {
  /** Bedwars level ("star"). */
  star: number;
  finalKills: number;
  finalDeaths: number;
  /** Final kill / death ratio. finalKills when finalDeaths is 0. */
  fkdr: number;
  wins: number;
  losses: number;
  /** Win / loss ratio. */
  wlr: number;
  /** Current winstreak, or null when the player hides it via the Hypixel API privacy setting. */
  winstreak: number | null;
  bedsBroken: number;
  bedsLost: number;
  /** Beds broken / beds lost ratio. */
  bblr: number;
  kills: number;
  deaths: number;
  kdr: number;
}

export type Threat = 'low' | 'medium' | 'high' | 'extreme' | 'nick' | 'unknown';

export type RowState =
  | 'loading'
  /** Stats fetched. */
  | 'ready'
  /** Username does not exist on Mojang's side: the player is nicked. */
  | 'nick'
  /** Account exists but has never logged into Hypixel. */
  | 'never-played'
  | 'error';

export interface PlayerRow {
  name: string;
  uuid?: string;
  /** Display rank such as "MVP+", or null for a default-rank player. */
  rank?: string | null;
  stats?: BedwarsStats;
  threat: Threat;
  state: RowState;
  error?: string;
  /** False once the player took a final death this game. */
  alive: boolean;
  /** False while the player is disconnected from the game. */
  connected: boolean;
  /** True when the row came from the local cache rather than a fresh API call. */
  fromCache: boolean;
  /** True for the local user (taken from the "Setting user:" launcher line). */
  self: boolean;
  updatedAt: number;
}

export interface Settings {
  /** Hypixel developer API key. Stored locally only. */
  apiKey: string;
  /** Absolute path to the client's latest.log. */
  logPath: string;
  /** Background opacity of the overlay, 0..1. Text is always fully opaque. */
  opacity: number;
  alwaysOnTop: boolean;
}

export interface StatusInfo {
  logPath: string;
  /** True while the log file exists and is being tailed. */
  watching: boolean;
  /** Hypixel requests waiting in the local queue. */
  queueLength: number;
  /** Hypixel requests currently in flight. */
  inFlight: number;
  /** Remaining requests reported by Hypixel's RateLimit-Remaining header, if known. */
  rateRemaining: number | null;
  statsCacheSize: number;
  uuidCacheSize: number;
  hasApiKey: boolean;
  /** Last human-readable notice (errors, key problems, ...). */
  message: string | null;
}

/** API the preload script exposes to the renderer as `window.akari`. */
export interface AkariApi {
  onRoster(cb: (rows: PlayerRow[]) => void): void;
  onStatus(cb: (status: StatusInfo) => void): void;
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  resetRoster(): void;
  refreshRoster(): void;
  openExternal(url: string): void;
  closeWindow(): void;
  minimizeWindow(): void;
}
