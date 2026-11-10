/**
 * Turns raw lines from the Minecraft client log into structured game events.
 *
 * Only chat lines the Hypixel server sends to every player are inspected.
 * Nothing here needs, or has, any access to the game process.
 */

export type LogEvent =
  /** The client was moved to another Hypixel server (lobby or game). */
  | { type: 'server-change'; server: string }
  /** Output of `/who`: the full list of players in the current game. */
  | { type: 'roster'; players: string[] }
  /** Pre-game "<name> has joined (3/8)!" message. */
  | { type: 'player-join'; player: string; count: number; max: number }
  /** Pre-game "<name> has quit!" message. */
  | { type: 'player-quit'; player: string }
  /** The Bedwars round started. */
  | { type: 'game-start' }
  /** A player took a final death and is out of the game. */
  | { type: 'final-kill'; victim: string }
  | { type: 'disconnect'; player: string }
  | { type: 'reconnect'; player: string }
  /** The local user's own username (from the launcher's "Setting user:" line). */
  | { type: 'self-name'; name: string };

/** Matches the chat payload regardless of client flavour (vanilla, Lunar, Badlion, Forge...). */
const CHAT_RE = /\[CHAT\]\s?(.*)$/;
/** Minecraft colour/format codes that some clients leave in the log. */
const FORMAT_CODE_RE = /§[0-9a-fk-or]/gi;
/** Optional leading rank tag such as "[MVP+] " or "[YOUTUBE] ". */
const RANK = String.raw`(?:\[[^\]]*\]\s+)?`;
const NAME = String.raw`(\w{1,16})`;

const SERVER_CHANGE_RE = /^Sending you to (\S+?)!?$/;
const WHO_RE = /^ONLINE: (.+)$/;
const JOIN_RE = new RegExp(`^${RANK}${NAME} has joined \\((\\d+)\\/(\\d+)\\)!$`);
const QUIT_RE = new RegExp(`^${RANK}${NAME} has quit!$`);
const GAME_START_RE = /^Protect your bed and destroy the enemy beds\.$/;
const FINAL_KILL_RE = new RegExp(`^${NAME}\\b.*\\bFINAL KILL!$`);
const DISCONNECT_RE = new RegExp(`^${NAME} disconnected\\.$`);
const RECONNECT_RE = new RegExp(`^${NAME} reconnected\\.$`);
const SELF_NAME_RE = /Setting user: (\w{1,16})/;

/** Parses one log line. Returns null for lines that are not interesting. */
export function parseLine(rawLine: string): LogEvent | null {
  const line = rawLine.replace(FORMAT_CODE_RE, '');

  const self = SELF_NAME_RE.exec(line);
  if (self) return { type: 'self-name', name: self[1] };

  const chat = CHAT_RE.exec(line);
  if (!chat) return null;
  const msg = chat[1].trim();
  if (!msg) return null;

  let m: RegExpExecArray | null;

  if ((m = SERVER_CHANGE_RE.exec(msg))) return { type: 'server-change', server: m[1] };

  if ((m = WHO_RE.exec(msg))) {
    const players = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\w{1,16}$/.test(s));
    return players.length ? { type: 'roster', players } : null;
  }

  if ((m = JOIN_RE.exec(msg))) {
    return { type: 'player-join', player: m[1], count: Number(m[2]), max: Number(m[3]) };
  }
  if ((m = QUIT_RE.exec(msg))) return { type: 'player-quit', player: m[1] };
  if (GAME_START_RE.test(msg)) return { type: 'game-start' };
  if ((m = FINAL_KILL_RE.exec(msg))) return { type: 'final-kill', victim: m[1] };
  if ((m = DISCONNECT_RE.exec(msg))) return { type: 'disconnect', player: m[1] };
  if ((m = RECONNECT_RE.exec(msg))) return { type: 'reconnect', player: m[1] };

  return null;
}
