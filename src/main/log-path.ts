/**
 * Finds the client log to tail. Every supported client writes a plain
 * `latest.log`; we just need to know where. When several exist, the one
 * modified most recently wins, which is almost always the client in use.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function candidateLogPaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  const lunar = path.join(home, '.lunarclient', 'offline', 'multiver', 'logs', 'latest.log');

  if (platform === 'win32') {
    const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const mc = path.join(appData, '.minecraft');
    return [
      lunar,
      path.join(mc, 'logs', 'latest.log'),
      path.join(mc, 'logs', 'blclient', 'minecraft', 'latest.log'), // Badlion
      path.join(appData, '.feather', 'logs', 'latest.log'), // Feather (some installs)
      path.join(appData, 'PrismLauncher', 'instances'), // handled below: scan instances
      path.join(appData, 'PolyMC', 'instances'),
    ].flatMap(expandLauncherInstances);
  }

  if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    const mc = path.join(support, 'minecraft');
    return [
      lunar,
      path.join(mc, 'logs', 'latest.log'),
      path.join(mc, 'logs', 'blclient', 'minecraft', 'latest.log'),
      path.join(support, 'PrismLauncher', 'instances'),
    ].flatMap(expandLauncherInstances);
  }

  // linux and everything else
  const dataHome = env.XDG_DATA_HOME ?? path.join(home, '.local', 'share');
  return [
    lunar,
    path.join(home, '.minecraft', 'logs', 'latest.log'),
    path.join(home, '.minecraft', 'logs', 'blclient', 'minecraft', 'latest.log'),
    path.join(dataHome, 'PrismLauncher', 'instances'),
    path.join(dataHome, 'PolyMC', 'instances'),
  ].flatMap(expandLauncherInstances);
}

/** Prism/PolyMC keep one `.minecraft` (or `minecraft`) folder per instance. */
function expandLauncherInstances(p: string): string[] {
  if (!p.endsWith('instances')) return [p];
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => [
        path.join(p, d.name, '.minecraft', 'logs', 'latest.log'),
        path.join(p, d.name, 'minecraft', 'logs', 'latest.log'),
      ]);
  } catch {
    return [];
  }
}

/** The most recently modified existing candidate, or null when none exist. */
export function detectLogPath(candidates: string[] = candidateLogPaths()): string | null {
  let best: { file: string; mtime: number } | null = null;
  for (const file of candidates) {
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.mtime) best = { file, mtime: st.mtimeMs };
    } catch {
      // not there
    }
  }
  return best?.file ?? null;
}
