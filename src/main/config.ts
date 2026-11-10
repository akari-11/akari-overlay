/**
 * Settings persistence. Lives in Electron's userData folder
 * (e.g. %APPDATA%\akari-overlay\config.json on Windows), never in the repo.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Settings } from '../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  logPath: '',
  opacity: 0.85,
  alwaysOnTop: true,
};

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Writes to a temp file then renames, so a crash mid-write cannot corrupt the target. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function sanitizeSettings(input: Partial<Settings> | null | undefined, base: Settings = DEFAULT_SETTINGS): Settings {
  const s = { ...base };
  if (!input) return s;
  if (typeof input.apiKey === 'string') s.apiKey = input.apiKey.trim();
  if (typeof input.logPath === 'string') s.logPath = input.logPath.trim();
  if (typeof input.opacity === 'number' && Number.isFinite(input.opacity)) {
    s.opacity = Math.min(1, Math.max(0.1, input.opacity));
  }
  if (typeof input.alwaysOnTop === 'boolean') s.alwaysOnTop = input.alwaysOnTop;
  return s;
}

export class SettingsStore {
  constructor(private readonly file: string) {}

  load(): Settings {
    return sanitizeSettings(readJson<Partial<Settings>>(this.file));
  }

  save(settings: Settings): void {
    writeJsonAtomic(this.file, settings);
  }
}
