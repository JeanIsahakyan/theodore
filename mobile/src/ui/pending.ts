/**
 * What you did before the host answered, as the screens show it (docs/mobile.md
 * "Optimistic sends"): the desktop's rule (docs/spaces.md "What you do shows
 * before the core answers") without React. The store is `src/state/pending.ts`;
 * these are its rules.
 *
 * ```text
 * send ─▶ bubble "Sending…" at once, the field cleared
 *   host: ok {message}            ─▶ "sent": kept until that row (or one with
 *                                    the same text, close in time) arrives,
 *                                    then dropped in favour of the row
 *   host: ok {queued, position}   ─▶ "Queued" (the mirrored queued row replaces it)
 *   refused / no answer in time   ─▶ "Not sent · Retry · Edit", never lost
 *   a host that mirrors no rows   ─▶ kept until a "Turn n: <text>" line past
 *                                    the send shows it was received
 * start ─▶ /space/<pending id> at once: the goal, "Starting on mac-A…"
 *   host: ok {space}              ─▶ the route replaced with the real space's
 *   refused                       ─▶ back on Home, the goal in the field, the error
 * answer ─▶ the card collapses to "Answered: <choice>"; refused ─▶ it comes back
 * ```
 */
import type { ChatMessage } from '../fleet/contract';
import type {
  AgentPicks,
  SendResult,
  SpaceLine,
  SubSpaceMessage,
} from '../fleet/types';
import type { FleetMode } from '../gen/fleet';
import type { Draft } from './logic';

export type PendingSendState = 'sending' | 'queued' | 'sent' | 'failed';

/** A message of yours the host hasn't shown yet. */
export interface PendingSend {
  /** Local, unique per app run. */
  key: string;
  /** The space (or sub-space) it went to. */
  space: string;
  /** An approval shows the same way, but is sent in the build mode. */
  kind: 'send' | 'approve';
  text: string;
  /** This device's clock when it was sent. */
  at: number;
  state: PendingSendState;
  /** The host's word: its place in the queue (1 runs next). */
  position: number | null;
  /** The host's id for the row, when its reply named one. */
  messageId: string | null;
  /** Why it wasn't sent. */
  error: string | null;
  /** What a retry sends again. */
  mode: FleetMode | null;
  picks: AgentPicks;
  /** The newest history line when it was sent: only a later "Turn" line
   *  shows it was received (a host that mirrors no rows). */
  afterSeq: number;
  /** How many times Retry sent it again (telemetry). */
  retries: number;
}

/** A space being started from Home, before the host said which it is. */
export interface PendingStart {
  /** `pending_<uuid>`: its route until the host names the space. */
  id: string;
  deviceId: string;
  hostName: string;
  projectId: string;
  projectName: string;
  goal: string;
  mode: FleetMode;
  picks: AgentPicks;
  at: number;
  state: 'starting' | 'failed';
  /** The real space, once the host's ok (or the wait's end) named it. */
  space: string | null;
  error: string | null;
}

/** An answer on its way to the host: the card shows it as given. */
export interface PendingAnswer {
  askId: string;
  space: string;
  /** "Answered: <choice>". */
  label: string;
  at: number;
}

/** A pending start's route id. */
export const PENDING_PREFIX = 'pending_';
export const isPendingId = (id: string): boolean =>
  id.startsWith(PENDING_PREFIX);

/**
 * A row of the chat matches an optimistic bubble this long apart on the two
 * clocks (the host's `at` against this device's). Generous: phones drift,
 * and a wrong match only drops a bubble whose text is on screen anyway.
 */
export const MATCH_WINDOW_MS = 5 * 60_000;

export interface NewSend {
  key: string;
  space: string;
  text: string;
  at: number;
  kind?: 'send' | 'approve';
  mode?: FleetMode | null;
  picks?: AgentPicks;
  afterSeq?: number;
}

export function newSend(input: NewSend): PendingSend {
  return {
    key: input.key,
    space: input.space,
    kind: input.kind ?? 'send',
    text: input.text,
    at: input.at,
    state: 'sending',
    position: null,
    messageId: null,
    error: null,
    mode: input.mode ?? null,
    picks: input.picks ?? {},
    afterSeq: input.afterSeq ?? 0,
    retries: 0,
  };
}

/** The host took it: queued behind the running turn, or its turn now. */
export function settleSend(p: PendingSend, r: SendResult): PendingSend {
  return {
    ...p,
    state: r.queued ? 'queued' : 'sent',
    position: r.queued ? r.position : null,
    messageId: r.message ?? p.messageId,
    error: null,
  };
}

/** Refused, or no answer in time: shown as not sent, with why. */
export function failSend(p: PendingSend, error: string): PendingSend {
  return { ...p, state: 'failed', position: null, error };
}

/** Retry: sent again, as new. */
export function retrySend(p: PendingSend, at: number): PendingSend {
  return {
    ...p,
    at,
    retries: p.retries + 1,
    state: 'sending',
    position: null,
    messageId: null,
    error: null,
  };
}

/** A row of the chat an optimistic bubble may stand for. */
export interface ChatRow {
  id: string | null;
  text: string;
  /** The host's clock. */
  at: number;
  /** Yours (not the agent's). */
  mine: boolean;
}

export const rowOfMessage = (m: ChatMessage): ChatRow => ({
  id: m.id,
  text: m.text,
  at: m.at,
  mine: m.author.kind === 'me',
});

export const rowOfSubSpaceMessage = (m: SubSpaceMessage): ChatRow => ({
  id: null,
  text: m.text,
  at: m.at,
  mine: m.from === 'user',
});

/**
 * `row` is the host's copy of `p`: the id its reply named, else your text
 * close in time. A failed send matches nothing: it never reached the host.
 */
export function matchesRow(p: PendingSend, row: ChatRow): boolean {
  if (p.state === 'failed' || !row.mine) return false;
  if (p.messageId !== null && row.id !== null) return row.id === p.messageId;
  return (
    row.text.trim() === p.text.trim() &&
    Math.abs(row.at - p.at) <= MATCH_WINDOW_MS
  );
}

/**
 * The bubbles still shown: those no row of the chat stands for. A row
 * takes at most one bubble (the oldest of the same text).
 */
export function unmatched(
  pending: readonly PendingSend[],
  rows: readonly ChatRow[],
): PendingSend[] {
  const taken = new Set<number>();
  return pending.filter((p) => {
    const i = rows.findIndex((r, j) => !taken.has(j) && matchesRow(p, r));
    if (i < 0) return true;
    taken.add(i);
    return false;
  });
}

const TURN_LINE = /^Turn \d+: /;

/** A history line shows the host took `p` as a turn: a "Turn n: <text>"
 *  line that came after the send (a host that mirrors no rows). */
export function matchesLine(p: PendingSend, line: SpaceLine): boolean {
  if (p.state === 'failed' || line.kind !== 'turn') return false;
  if (line.seq <= p.afterSeq) return false;
  const text = line.text.replace(TURN_LINE, '');
  const sent = p.text.trim();
  // `lineOf` cuts the turn's text at 2000 characters.
  return text === sent || ([...sent].length > 2000 && sent.startsWith(text));
}

/** The bubbles no history line stands for (a host that mirrors no rows). */
export function unmatchedByLines(
  pending: readonly PendingSend[],
  lines: readonly SpaceLine[],
): PendingSend[] {
  const taken = new Set<number>();
  return pending.filter((p) => {
    const i = lines.findIndex((l, j) => !taken.has(j) && matchesLine(p, l));
    if (i < 0) return true;
    taken.add(i);
    return false;
  });
}

/** The word over a bubble. */
export function pendingLabel(p: PendingSend): string {
  switch (p.state) {
    case 'sending':
      return 'Sending…';
    case 'queued':
      return p.position !== null && p.position > 1
        ? `Queued · ${p.position} in line`
        : 'Queued';
    case 'sent':
      return 'Sent';
    case 'failed':
      return 'Not sent';
  }
}

/** How many of them wait in the space's queue: sent while it ran, or still
 *  without the host's word while it runs. */
export function queuedCount(
  pending: readonly PendingSend[],
  running: boolean,
): number {
  return pending.filter(
    (p) => p.state === 'queued' || (running && p.state === 'sending'),
  ).length;
}

/** Approve is in flight: its bubble is sending (the actions step aside). */
export const approving = (pending: readonly PendingSend[]): boolean =>
  pending.some((p) => p.kind === 'approve' && p.state === 'sending');

/** "Starting on mac-A…" */
export const startingLabel = (hostName: string): string =>
  `Starting on ${hostName}…`;

/** The pending start's title: the goal's first line, cut near 60 characters. */
export function startTitle(goal: string): string {
  const line =
    goal
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? 'New space';
  const t = line.replace(/[.。!]+$/u, '');
  if (t.length <= 60) return t;
  const cut = t.slice(0, 60);
  const word = cut.lastIndexOf(' ');
  return `${(word > 30 ? cut.slice(0, word) : cut).replace(/[,;:]$/, '')}…`;
}

/** A start that reached the host (or the wait's end): it names the space. */
export function startLanded(p: PendingStart, space: string): PendingStart {
  return { ...p, state: 'starting', space, error: null };
}

export function startRefused(p: PendingStart, error: string): PendingStart {
  return { ...p, state: 'failed', space: null, error };
}

/**
 * "Answered: <choice>": the options picked, the free text, per question
 * (several questions joined with " · "); a long answer cut.
 */
export function answeredLabel(drafts: readonly Draft[]): string {
  const parts = drafts
    .map((d) => {
      const other = d.other.trim();
      return [...d.selected, ...(other ? [other] : [])].join(', ');
    })
    .filter((s) => s !== '');
  const text = parts.join(' · ');
  const chars = [...text];
  return `Answered: ${chars.length > 120 ? `${chars.slice(0, 119).join('')}…` : text}`;
}
