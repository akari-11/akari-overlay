/*
 * Renderer. Runs sandboxed in the overlay window with no Node access; the
 * only way in or out is `window.akari` (see preload.ts). This file is a plain
 * script (no imports) so tsc emits browser-ready JS.
 */
type PlayerRow = import('../shared/types').PlayerRow;
type StatusInfo = import('../shared/types').StatusInfo;
type Settings = import('../shared/types').Settings;
type Threat = import('../shared/types').Threat;

declare const akari: import('../shared/types').AkariApi;

type SortKey = 'name' | 'star' | 'fkdr' | 'finalKills' | 'wins' | 'wlr' | 'winstreak' | 'threat';

const THREAT_ORDER: Record<Threat, number> = {
  nick: 5,
  extreme: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const els = {
  status: $('status'),
  rows: $<HTMLTableSectionElement>('rows'),
  table: $<HTMLTableElement>('table'),
  empty: $('empty'),
  message: $('message'),
  settings: $('settings'),
  inKey: $<HTMLInputElement>('in-key'),
  inLog: $<HTMLInputElement>('in-log'),
  inOpacity: $<HTMLInputElement>('in-opacity'),
  inTop: $<HTMLInputElement>('in-top'),
};

let rows: PlayerRow[] = [];
let sortKey: SortKey = 'threat';
let sortAsc = false;

/* ---- helpers --------------------------------------------------------- */

function sortValue(row: PlayerRow, key: SortKey): number | string {
  if (key === 'name') return row.name.toLowerCase();
  if (key === 'threat') return THREAT_ORDER[row.threat] * 1000 + (row.stats?.fkdr ?? 0);
  const s = row.stats;
  if (!s) return -1;
  const v = s[key];
  return v === null ? -1 : v;
}

function sorted(): PlayerRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    let cmp = av < bv ? -1 : av > bv ? 1 : 0;
    if (cmp === 0) cmp = a.name.localeCompare(b.name);
    return sortAsc ? cmp : -cmp;
  });
  return copy;
}

function fmt(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined) return '—';
  return digits ? n.toFixed(digits) : String(Math.round(n));
}

function tagText(row: PlayerRow): string {
  switch (row.state) {
    case 'loading':
      return '…';
    case 'nick':
      return 'nick';
    case 'never-played':
      return 'new';
    case 'error':
      return 'error';
    default:
      return row.threat;
  }
}

function td(text: string, cls?: string, title?: string): HTMLTableCellElement {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (cls) cell.className = cls;
  if (title) cell.title = title;
  return cell;
}

/* ---- rendering ------------------------------------------------------- */

function render(): void {
  const frag = document.createDocumentFragment();
  for (const row of sorted()) {
    const tr = document.createElement('tr');
    const classes = [`threat-${row.threat}`];
    if (!row.alive) classes.push('dead');
    if (!row.connected) classes.push('disconnected');
    if (row.self) classes.push('self');
    if (row.fromCache) classes.push('cached');
    tr.className = classes.join(' ');

    const name = document.createElement('td');
    name.className = 'left';
    if (row.rank) {
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = row.rank;
      name.appendChild(rank);
    }
    name.appendChild(document.createTextNode(row.name));
    if (row.error) name.title = row.error;
    tr.appendChild(name);

    const s = row.stats;
    const dim = s ? '' : 'dim';
    tr.appendChild(td(fmt(s?.star), `star ${dim}`));
    tr.appendChild(td(fmt(s?.fkdr, 2), `fkdr ${dim}`));
    tr.appendChild(td(fmt(s?.finalKills), dim));
    tr.appendChild(td(fmt(s?.wins), dim));
    tr.appendChild(td(fmt(s?.wlr, 2), dim));
    tr.appendChild(td(s ? fmt(s.winstreak) : '—', dim, s?.winstreak === null ? 'hidden by player' : undefined));

    const tagCell = document.createElement('td');
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = tagText(row);
    if (row.error) tag.title = row.error;
    tagCell.appendChild(tag);
    tr.appendChild(tagCell);

    frag.appendChild(tr);
  }
  els.rows.replaceChildren(frag);
  els.empty.classList.toggle('hidden', rows.length > 0);
  els.table.classList.toggle('hidden', rows.length === 0);

  for (const th of els.table.querySelectorAll<HTMLTableCellElement>('th[data-sort]')) {
    const active = th.dataset.sort === sortKey;
    th.classList.toggle('sorted', active);
    th.classList.toggle('asc', active && sortAsc);
  }
}

function renderStatus(st: StatusInfo): void {
  const parts: string[] = [];
  parts.push(st.watching ? 'tailing log' : 'no log');
  if (st.queueLength || st.inFlight) parts.push(`queue ${st.queueLength}+${st.inFlight}`);
  parts.push(`cache ${st.statsCacheSize}`);
  if (st.rateRemaining !== null) parts.push(`api ${st.rateRemaining} left`);
  els.status.textContent = parts.join(' · ');
  els.status.className = `status ${st.watching ? 'live' : 'idle'}`;

  if (st.message) {
    els.message.textContent = st.message;
    const info = /updated|cleared|Waiting/i.test(st.message);
    els.message.className = `message${info ? ' info' : ''}`;
  } else {
    els.message.className = 'message hidden';
  }
}

/* ---- settings panel -------------------------------------------------- */

function applyOpacity(value: number): void {
  document.documentElement.style.setProperty('--bg-alpha', String(value));
}

async function loadSettings(): Promise<void> {
  const s = await akari.getSettings();
  fillSettings(s);
  applyOpacity(s.opacity);
}

function fillSettings(s: Settings): void {
  els.inKey.value = s.apiKey;
  els.inLog.value = s.logPath;
  els.inOpacity.value = String(s.opacity);
  els.inTop.checked = s.alwaysOnTop;
}

async function saveSettings(): Promise<void> {
  const saved = await akari.saveSettings({
    apiKey: els.inKey.value,
    logPath: els.inLog.value,
    opacity: Number(els.inOpacity.value),
    alwaysOnTop: els.inTop.checked,
  });
  fillSettings(saved);
  applyOpacity(saved.opacity);
  els.settings.classList.add('hidden');
}

/* ---- wiring ---------------------------------------------------------- */

$('btn-refresh').addEventListener('click', () => akari.refreshRoster());
$('btn-reset').addEventListener('click', () => akari.resetRoster());
$('btn-min').addEventListener('click', () => akari.minimizeWindow());
$('btn-close').addEventListener('click', () => akari.closeWindow());
$('btn-settings').addEventListener('click', () => els.settings.classList.toggle('hidden'));
$('btn-save').addEventListener('click', () => void saveSettings());
$('link-key').addEventListener('click', (e) => {
  e.preventDefault();
  akari.openExternal('https://developer.hypixel.net/');
});
els.inOpacity.addEventListener('input', () => applyOpacity(Number(els.inOpacity.value)));
els.settings.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') void saveSettings();
});

for (const th of els.table.querySelectorAll<HTMLTableCellElement>('th[data-sort]')) {
  th.addEventListener('click', () => {
    const key = th.dataset.sort as SortKey;
    if (key === sortKey) sortAsc = !sortAsc;
    else {
      sortKey = key;
      sortAsc = key === 'name';
    }
    render();
  });
}

akari.onRoster((next) => {
  rows = next;
  render();
});
akari.onStatus(renderStatus);

void loadSettings();
render();
