/**
 * Username -> UUID resolution.
 *
 * Mojang's public profile endpoint is the source of truth. PlayerDB is used as
 * a fallback only when Mojang itself is failing (5xx / rate limited), never
 * when Mojang says the name does not exist, because a missing name is exactly
 * how a nicked player shows up.
 */

export interface ResolvedProfile {
  /** 32-character hex UUID without dashes. */
  uuid: string;
  /** Correctly-cased username. */
  name: string;
}

export interface ResolveOptions {
  fetchImpl?: typeof fetch;
  mojangBase?: string;
  playerDbBase?: string;
  userAgent?: string;
}

export class ProfileLookupError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ProfileLookupError';
  }
}

const UUID_RE = /^[0-9a-f]{32}$/i;

export function normalizeUuid(raw: string): string {
  return raw.replace(/-/g, '').toLowerCase();
}

/**
 * Resolves a username. Returns null when no such account exists (i.e. the
 * player is nicked), throws ProfileLookupError when both services are unavailable.
 */
export async function resolveUuid(name: string, opts: ResolveOptions = {}): Promise<ResolvedProfile | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = { 'User-Agent': opts.userAgent ?? 'akari-overlay (https://github.com/akari-11/akari-overlay)' };

  const mojangBase = opts.mojangBase ?? 'https://api.mojang.com';
  let mojangStatus = 0;
  try {
    const res = await fetchImpl(`${mojangBase}/users/profiles/minecraft/${encodeURIComponent(name)}`, { headers });
    mojangStatus = res.status;
    if (res.status === 404 || res.status === 204) return null;
    if (res.ok) {
      const body = (await res.json()) as { id?: string; name?: string };
      if (body.id && UUID_RE.test(normalizeUuid(body.id))) {
        return { uuid: normalizeUuid(body.id), name: body.name ?? name };
      }
      return null;
    }
  } catch {
    // network error: fall through to PlayerDB
  }

  const playerDbBase = opts.playerDbBase ?? 'https://playerdb.co';
  try {
    const res = await fetchImpl(`${playerDbBase}/api/player/minecraft/${encodeURIComponent(name)}`, { headers });
    if (res.status === 404) return null;
    if (res.ok) {
      const body = (await res.json()) as {
        success?: boolean;
        code?: string;
        data?: { player?: { id?: string; username?: string } };
      };
      if (body.success && body.data?.player?.id) {
        return { uuid: normalizeUuid(body.data.player.id), name: body.data.player.username ?? name };
      }
      if (body.code === 'minecraft.api_failure') return null;
    }
    throw new ProfileLookupError(`PlayerDB HTTP ${res.status}`, res.status);
  } catch (err) {
    if (err instanceof ProfileLookupError) throw err;
    throw new ProfileLookupError(`Profile lookup failed (Mojang ${mojangStatus || 'unreachable'}, PlayerDB unreachable)`, mojangStatus);
  }
}
