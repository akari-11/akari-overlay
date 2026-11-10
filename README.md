# Akari Overlay

A lightweight Hypixel Bedwars stats overlay. It reads your Minecraft client's
`latest.log`, resolves the players it sees there, and shows their Bedwars stats
in a small always-on-top window.

It does **not** inject into the game, read game memory, modify the client, or
send any packets. The game never knows it is running.

---

## How it works

```
 Minecraft client ──writes──▶ latest.log
                                  │
                                  ▼  (poll every 250 ms, read only new bytes)
                          core/log-watcher.ts
                                  │  raw lines
                                  ▼
                          core/log-parser.ts      "Alice has joined (3/8)!", "ONLINE: …", …
                                  │  LogEvent
                                  ▼
                          core/session.ts  ◀──────────── caches (name→uuid, uuid→stats)
                                  │  miss
                   ┌──────────────┴──────────────┐
                   ▼                             ▼
            core/mojang.ts                core/hypixel.ts
      api.mojang.com (name→uuid)     api.hypixel.net/v2/player
                                     via core/rate-limiter.ts
                                  │
                                  ▼
                        core/bedwars-stats.ts     star, FKDR, WLR, winstreak, threat tag
                                  │
                                  ▼
                   main/main.ts ──IPC──▶ renderer/  (sandboxed table UI)
```

The whole pipeline is ordinary file reading and HTTPS requests. The core
modules have no Electron dependency and are covered by unit tests.

### Log reading

`LogWatcher` behaves like `tail -f` but never keeps the file open. Each poll
is one `stat()`; only when the file has grown does it open the file, read the
new bytes from the last offset, and close it again. Truncation (new session)
and a missing file (client not started yet) are handled automatically.
Idle CPU cost is effectively zero.

`parseLine` recognises these server messages (colour codes stripped, any
client's log prefix accepted):

| Message                                      | Event            |
| -------------------------------------------- | ---------------- |
| `Sending you to mini121A!`                   | new server → clear the table |
| `ONLINE: Alice, Bob, …` (output of `/who`)   | full roster      |
| `[MVP+] Alice has joined (3/8)!`             | player joined    |
| `Alice has quit!`                            | player left      |
| `Protect your bed and destroy the enemy beds.` | game started   |
| `Alice was … by Bob. FINAL KILL!`            | Alice is out (row dims) |
| `Alice disconnected.` / `Alice reconnected.` | connection state |
| `Setting user: Alice` (launcher line)        | your own name (row highlighted) |

### Caching

Two caches, both LRU with per-entry expiry (`core/cache.ts`), persisted to
`cache.json` in the app's user-data folder so they survive restarts:

| Cache          | Key            | TTL         | Purpose |
| -------------- | -------------- | ----------- | ------- |
| name → UUID    | lowercase name | 24 h (nicks: 10 min) | one Mojang call per player per day |
| UUID → stats   | UUID           | **30 min**  | one Hypixel call per player per half hour |

A player you met in your last game costs zero requests in the next one.
Manual refresh (`Ctrl+Shift+F`) bypasses the stats cache for the current
table only.

### Rate limiting

All Hypixel calls go through a token-bucket queue (`core/rate-limiter.ts`):

- **0.9 requests/second sustained, burst of 20**, 4 in flight at most.
  Worst case over any 5-minute window is 20 + 0.9 × 300 = 290 requests,
  under the 300 / 5 min limit of a standard key.
- The client reads Hypixel's `RateLimit-Remaining` / `RateLimit-Reset`
  response headers and pauses the queue when fewer than 5 requests remain.
- On HTTP `429` it pauses for `Retry-After`, waits, and retries once.
- Duplicate names in one game are never requested twice; concurrent lookups
  are de-duplicated by the roster.

Mojang lookups use a separate, gentler queue (2/s, burst 10).

### Hypixel API policy

The overlay is designed to stay within the
[Hypixel Public API policies](https://developer.hypixel.net/policies/):

- Your API key is stored **locally only** (`config.json` in your user-data
  folder) and sent to `api.hypixel.net` and nowhere else. It is never
  committed, logged, or shared.
- Requests are rate-limited well below the key's quota (see above) and cached
  aggressively, so repeated games produce very little traffic.
- Only the `/v2/player` endpoint is used, and only for players currently in
  your game.
- No data is scraped, aggregated, or stored beyond the 30-minute cache.

Log-reading overlays like this one do not touch the Minecraft client and are
widely used on Hypixel. Still, rules can change: it is your responsibility to
check the current [Hypixel rules](https://hypixel.net/rules) and API policies
before use.

---

## Getting a Hypixel API key

1. Go to <https://developer.hypixel.net/> and sign in with your Minecraft
   account.
2. **Development key**: available instantly from the dashboard, valid for
   24 hours, renewable. Fine for personal use.
3. **Production key**: apply from the same dashboard if you want a key that
   does not expire. The *Architecture*, *Caching* and *Rate limiting* sections
   above describe exactly what this tool does with the key; link to this
   README in your application.
4. Paste the key into the overlay: click ⚙ → *Hypixel API key* → *Save*.

---

## Install & run

Requirements: [Node.js](https://nodejs.org/) 20 or newer.

```bash
git clone https://github.com/akari-11/akari-overlay.git
cd akari-overlay
npm install
npm start
```

`npm start` compiles the TypeScript and launches the overlay. To build an
installer for your platform (NSIS on Windows, DMG on macOS, AppImage on Linux):

```bash
npm run dist      # output in release/
```

### First launch

The overlay looks for the most recently modified `latest.log` among:

| Client           | Windows                                                      |
| ---------------- | ------------------------------------------------------------ |
| Vanilla / Forge / Fabric | `%APPDATA%\.minecraft\logs\latest.log`              |
| Lunar Client     | `%USERPROFILE%\.lunarclient\offline\multiver\logs\latest.log` |
| Badlion          | `%APPDATA%\.minecraft\logs\blclient\minecraft\latest.log`    |
| Prism / PolyMC   | `%APPDATA%\PrismLauncher\instances\<instance>\.minecraft\logs\latest.log` |

macOS and Linux equivalents are detected too. If yours is somewhere else, set
the path under ⚙ → *Log file*.

Then join a Bedwars lobby, or type `/who` in an ongoing game, and the table
fills in.

### Hotkeys (global)

| Keys               | Action                              |
| ------------------ | ----------------------------------- |
| `Ctrl+Shift+R`     | Clear the table                     |
| `Ctrl+Shift+F`     | Re-fetch everyone (bypasses cache)  |
| `Ctrl+Shift+O`     | Show / hide the overlay             |

Drag the window by its top bar. Resize from any edge.

### Columns

| Column | Meaning |
| ------ | ------- |
| ★      | Bedwars level (star) |
| FKDR   | Final kills ÷ final deaths |
| Finals | Final kills |
| Wins   | Wins |
| WLR    | Wins ÷ losses |
| WS     | Current winstreak (`—` when the player hides it) |
| Tag    | `low` / `medium` / `high` / `extreme` threat from FKDR and star; `nick` when the name does not exist on Mojang; `new` for an account that never joined Hypixel |

Dimmed, struck-through rows took a final death this game. `⚡` marks a
disconnected player. Your own row is highlighted.

---

## Project layout

```
akari-overlay/
├── package.json
├── tsconfig.json
├── scripts/
│   └── copy-static.js        copies html/css into dist/
└── src/
    ├── shared/
    │   └── types.ts          types shared by main, core and renderer
    ├── core/                 pure Node, no Electron, unit-tested
    │   ├── log-watcher.ts    cheap tail -f
    │   ├── log-parser.ts     log line → LogEvent
    │   ├── cache.ts          TTL + LRU cache, JSON-serialisable
    │   ├── rate-limiter.ts   token bucket + async queue
    │   ├── mojang.ts         name → UUID (Mojang, PlayerDB fallback)
    │   ├── hypixel.ts        /v2/player client, rate-limit aware
    │   ├── bedwars-stats.ts  star / FKDR / WLR / rank / threat maths
    │   ├── session.ts        roster + cache orchestration
    │   └── *.test.ts         node:test suites
    ├── main/                 Electron main process
    │   ├── main.ts           window, hotkeys, IPC, wiring
    │   ├── preload.ts        contextBridge → window.akari
    │   ├── config.ts         settings persistence
    │   └── log-path.ts       finds latest.log per client/platform
    └── renderer/             sandboxed UI (no Node access)
        ├── index.html
        ├── styles.css
        └── renderer.ts
```

## Development

```bash
npm test          # build + run unit tests
npm run typecheck # tsc --noEmit
npm start -- --dev   # launches with DevTools attached
```

Settings and caches live in Electron's user-data folder
(`%APPDATA%\akari-overlay\` on Windows): `config.json` and `cache.json`.
Delete them to reset.

## License

MIT © akari-11
