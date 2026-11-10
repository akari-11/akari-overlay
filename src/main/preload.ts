/**
 * The only bridge between the sandboxed renderer and the main process.
 * The renderer has no Node access; it can call exactly these functions.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { AkariApi, PlayerRow, Settings, StatusInfo } from '../shared/types';

const api: AkariApi = {
  onRoster: (cb) => {
    ipcRenderer.on('roster', (_event, rows: PlayerRow[]) => cb(rows));
  },
  onStatus: (cb) => {
    ipcRenderer.on('status', (_event, status: StatusInfo) => cb(status));
  },
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch) as Promise<Settings>,
  resetRoster: () => ipcRenderer.send('roster:reset'),
  refreshRoster: () => ipcRenderer.send('roster:refresh'),
  openExternal: (url) => ipcRenderer.send('shell:open', url),
  closeWindow: () => ipcRenderer.send('window:close'),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
};

contextBridge.exposeInMainWorld('akari', api);
