/**
 * Electron entry point. Wires the log watcher -> parser -> tracker pipeline to
 * a small always-on-top window and a handful of global hotkeys.
 */
import { app, BrowserWindow, globalShortcut, ipcMain, shell } from 'electron';
import * as path from 'node:path';
import { HypixelClient } from '../core/hypixel';
import { LogWatcher } from '../core/log-watcher';
import { parseLine } from '../core/log-parser';
import { resolveUuid } from '../core/mojang';
import { RequestQueue } from '../core/rate-limiter';
import { PlayerTracker, type TrackerCaches } from '../core/session';
import type { Settings, StatusInfo } from '../shared/types';
import { readJson, sanitizeSettings, SettingsStore, writeJsonAtomic } from './config';
import { detectLogPath } from './log-path';

const DEV = process.argv.includes('--dev');

// Hypixel keys allow 300 requests per 5 minutes (1/s). Stay under it even with
// the initial burst: 20 + 0.9 * 300 = 290 per 5 minutes worst case.
const hypixelQueue = new RequestQueue({ ratePerSecond: 0.9, burst: 20, concurrency: 4 });
// Mojang's limit is per IP and generous; this just keeps us polite.
const mojangQueue = new RequestQueue({ ratePerSecond: 2, burst: 10, concurrency: 4 });

let win: BrowserWindow | null = null;
let settingsStore: SettingsStore;
let settings: Settings;
let cacheFile: string;
let hypixel: HypixelClient;
let tracker: PlayerTracker;
let watcher: LogWatcher | null = null;
let lastMessage: string | null = null;
let rosterPushTimer: NodeJS.Timeout | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(boot);
}

function boot(): void {
  const userData = app.getPath('userData');
  settingsStore = new SettingsStore(path.join(userData, 'config.json'));
  settings = settingsStore.load();
  if (!settings.logPath) {
    settings.logPath = detectLogPath() ?? '';
    settingsStore.save(settings);
  }
  cacheFile = path.join(userData, 'cache.json');

  hypixel = new HypixelClient({ apiKey: settings.apiKey, queue: hypixelQueue });
  tracker = new PlayerTracker({
    hypixel,
    resolveProfile: (name) => mojangQueue.schedule(() => resolveUuid(name)),
  });
  tracker.importCaches(readJson<TrackerCaches>(cacheFile));
  tracker.on('update', scheduleRosterPush);
  tracker.on('notice', (msg) => {
    lastMessage = msg;
    pushStatus();
  });

  createWindow();
  registerShortcuts();
  registerIpc();
  startWatcher();

  setInterval(pushStatus, 1000);
  setInterval(saveCaches, 5 * 60_000);

  if (!settings.apiKey) lastMessage = 'No API key set. Open settings (⚙) and paste your Hypixel developer key.';
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 640,
    height: 400,
    minWidth: 420,
    minHeight: 160,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: false,
    title: 'Akari Overlay',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 'screen-saver' is the highest level; it keeps the overlay above borderless-fullscreen games.
  if (settings.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    pushRoster();
    pushStatus();
  });
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  win.on('closed', () => {
    win = null;
  });
}

function registerShortcuts(): void {
  const bind = (accel: string, fn: () => void) => {
    if (!globalShortcut.register(accel, fn)) {
      lastMessage = `Could not bind hotkey ${accel} (already in use?)`;
    }
  };
  bind('CommandOrControl+Shift+R', () => tracker.reset());
  bind('CommandOrControl+Shift+F', () => tracker.refresh());
  bind('CommandOrControl+Shift+O', () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else win.show();
  });
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_event, patch: Partial<Settings>) => {
    const next = sanitizeSettings(patch, settings);
    const logChanged = next.logPath !== settings.logPath;
    const keyChanged = next.apiKey !== settings.apiKey;
    settings = next;
    settingsStore.save(settings);
    if (keyChanged) {
      hypixel.setApiKey(settings.apiKey);
      lastMessage = settings.apiKey ? 'API key updated.' : 'API key cleared.';
      if (settings.apiKey) tracker.refresh();
    }
    if (logChanged) startWatcher();
    if (win) {
      win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
    }
    pushStatus();
    return settings;
  });
  ipcMain.on('roster:reset', () => tracker.reset());
  ipcMain.on('roster:refresh', () => tracker.refresh());
  ipcMain.on('window:close', () => app.quit());
  ipcMain.on('window:minimize', () => win?.minimize());
  ipcMain.on('shell:open', (_event, url: string) => {
    // Only ever open https links the renderer was given, never arbitrary protocols.
    if (typeof url === 'string' && /^https:\/\//.test(url)) void shell.openExternal(url);
  });
}

function startWatcher(): void {
  watcher?.stop();
  watcher = null;
  if (!settings.logPath) {
    lastMessage = 'No Minecraft log found. Set the path to latest.log in settings (⚙).';
    pushStatus();
    return;
  }
  const w = new LogWatcher(settings.logPath);
  w.on('line', (line) => {
    const ev = parseLine(line);
    if (ev) tracker.handleEvent(ev);
  });
  w.on('missing', () => {
    lastMessage = `Waiting for log file: ${settings.logPath}`;
    pushStatus();
  });
  w.on('found', () => {
    lastMessage = null;
    pushStatus();
  });
  w.on('error', (err) => {
    lastMessage = `Log watcher error: ${err.message}`;
    pushStatus();
  });
  w.start();
  watcher = w;
}

function scheduleRosterPush(): void {
  // Coalesce bursts of updates (e.g. 16 players resolving) into one IPC message.
  if (rosterPushTimer) return;
  rosterPushTimer = setTimeout(() => {
    rosterPushTimer = null;
    pushRoster();
  }, 50);
}

function send(channel: string, payload: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
    // window is going away; nothing to show it to
  }
}

function pushRoster(): void {
  send('roster', tracker.snapshot());
}

function pushStatus(): void {
  if (!win || win.isDestroyed()) return;
  const status: StatusInfo = {
    logPath: settings.logPath,
    watching: watcher !== null && watcher.isRunning && !watcher.isMissing,
    queueLength: hypixelQueue.length,
    inFlight: hypixelQueue.inFlight,
    rateRemaining: hypixel.rateRemaining,
    statsCacheSize: tracker.statsCache.size,
    uuidCacheSize: tracker.uuidCache.size,
    hasApiKey: hypixel.hasApiKey,
    message: lastMessage,
  };
  send('status', status);
}

function saveCaches(): void {
  try {
    writeJsonAtomic(cacheFile, tracker.exportCaches());
  } catch (err) {
    lastMessage = `Could not save cache: ${(err as Error).message}`;
  }
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  watcher?.stop();
  if (tracker) saveCaches();
});

app.on('window-all-closed', () => app.quit());
