/**
 * Pure functions that turn a raw Hypixel `player` object into the numbers the
 * overlay shows. No I/O here, so everything is unit-testable.
 */
import type { BedwarsStats, Threat } from '../shared/types';

/** Subset of the Hypixel `/v2/player` payload the overlay reads. */
export interface HypixelPlayer {
  uuid?: string;
  displayname?: string;
  rank?: string;
  prefix?: string;
  packageRank?: string;
  newPackageRank?: string;
  monthlyPackageRank?: string;
  achievements?: { bedwars_level?: number };
  stats?: {
    Bedwars?: Record<string, unknown>;
  };
}

/** XP needed for each level inside a prestige: the first four are cheaper, every later one costs 5000. */
const EASY_LEVEL_XP = [500, 1000, 2000, 3500];
/** Total XP for one full prestige (100 levels): 500 + 1000 + 2000 + 3500 + 96 * 5000. */
const XP_PER_PRESTIGE = 487_000;

/** Converts raw Bedwars experience into a (whole) star level. */
export function starFromExperience(exp: number): number {
  if (!Number.isFinite(exp) || exp <= 0) return 0;
  const prestiges = Math.floor(exp / XP_PER_PRESTIGE);
  let remaining = exp - prestiges * XP_PER_PRESTIGE;
  let level = prestiges * 100;
  for (const cost of EASY_LEVEL_XP) {
    if (remaining < cost) return level;
    remaining -= cost;
    level++;
  }
  return level + Math.floor(remaining / 5000);
}

/** a / b, with a sensible value when b is 0 (a itself, the convention every stats site uses). */
export function ratio(a: number, b: number): number {
  if (b === 0) return a;
  return Math.round((a / b) * 100) / 100;
}

function num(bw: Record<string, unknown>, key: string): number {
  const v = bw[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Builds the overlay's stat block from a Hypixel player payload. */
export function extractBedwarsStats(player: HypixelPlayer): BedwarsStats {
  const bw = player.stats?.Bedwars ?? {};

  const star =
    typeof player.achievements?.bedwars_level === 'number'
      ? player.achievements.bedwars_level
      : starFromExperience(num(bw, 'Experience'));

  const finalKills = num(bw, 'final_kills_bedwars');
  const finalDeaths = num(bw, 'final_deaths_bedwars');
  const wins = num(bw, 'wins_bedwars');
  const losses = num(bw, 'losses_bedwars');
  const bedsBroken = num(bw, 'beds_broken_bedwars');
  const bedsLost = num(bw, 'beds_lost_bedwars');
  const kills = num(bw, 'kills_bedwars');
  const deaths = num(bw, 'deaths_bedwars');

  // Hypixel omits `winstreak` entirely when the player hides it in their API settings.
  const ws = bw['winstreak'];
  const winstreak = typeof ws === 'number' && Number.isFinite(ws) ? ws : null;

  return {
    star,
    finalKills,
    finalDeaths,
    fkdr: ratio(finalKills, finalDeaths),
    wins,
    losses,
    wlr: ratio(wins, losses),
    winstreak,
    bedsBroken,
    bedsLost,
    bblr: ratio(bedsBroken, bedsLost),
    kills,
    deaths,
    kdr: ratio(kills, deaths),
  };
}

const PACKAGE_RANKS: Record<string, string> = {
  VIP: 'VIP',
  VIP_PLUS: 'VIP+',
  MVP: 'MVP',
  MVP_PLUS: 'MVP+',
  SUPERSTAR: 'MVP++',
};

const STAFF_RANKS: Record<string, string> = {
  ADMIN: 'ADMIN',
  GAME_MASTER: 'GM',
  YOUTUBER: 'YOUTUBE',
  MODERATOR: 'MOD',
  HELPER: 'HELPER',
};

/** Human-readable rank tag, or null for a default-rank player. */
export function rankOf(player: HypixelPlayer): string | null {
  if (player.prefix) {
    const clean = player.prefix.replace(/§[0-9a-fk-or]/gi, '').replace(/[[\]]/g, '').trim();
    if (clean) return clean;
  }
  if (player.rank && player.rank !== 'NORMAL') return STAFF_RANKS[player.rank] ?? player.rank;
  if (player.monthlyPackageRank === 'SUPERSTAR') return 'MVP++';
  const pkg = player.newPackageRank ?? player.packageRank;
  if (pkg && pkg !== 'NONE') return PACKAGE_RANKS[pkg] ?? pkg;
  return null;
}

/**
 * Rough danger rating for the table's Tag column. Thresholds follow the
 * conventions most public overlays use; tweak freely.
 */
export function threatLevel(stats: BedwarsStats): Threat {
  const { fkdr, star } = stats;
  if (fkdr >= 8 || star >= 600 || (fkdr >= 5 && star >= 300)) return 'extreme';
  if (fkdr >= 3 || star >= 300) return 'high';
  if (fkdr >= 1.2 || star >= 100) return 'medium';
  return 'low';
}
