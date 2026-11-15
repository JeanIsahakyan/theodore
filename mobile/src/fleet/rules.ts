/**
 * What may be shown, and how, mirroring the desktop core
 * (`crates/app/src/usecases/fleet.rs`, `fleet_origin.rs`).
 */
import type { FleetMode, RemoteQuestion, RemoteSpaceEvent } from '../gen/fleet';
import type { LineKind, SpaceLine, SpaceStatus } from './types';

/** `^dev_[0-9a-f-]{36}$`: a device id as the cloud issues it. */
export function validDeviceId(id: unknown): id is string {
  return typeof id === 'string' && /^dev_[0-9a-f-]{36}$/.test(id);
}

const PIN_NAME_MAX = 40;

/**
 * A device name as pinned here: only `[A-Za-z0-9 ._()-]`, ≤ 40 characters,
 * `device` when nothing is left (the cloud's listing is unsigned).
 */
export function pinName(name: string): string {
  const kept = [...name]
    .filter((c) => /^[A-Za-z0-9 ._()-]$/.test(c))
    .slice(0, PIN_NAME_MAX)
    .join('')
    .trim();
  return kept || 'device';
}

/** A refusal code as it may be shown: `fleet.offline`-like, else `fleet.unknown`. */
export function safeCode(code: unknown): string {
  return typeof code === 'string' && /^[a-z0-9_.]{1,64}$/.test(code)
    ? code
    : 'fleet.unknown';
}

/** At most `max` characters (code points) of `s`. */
export function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max).join('');
}

/** Most characters of a verified refusal's words shown. */
export const ERROR_TEXT_MAX = 200;
/** Most characters of a space name or branch taken from a signed reply. */
export const NAME_MAX = 200;
/** History kept per space. */
export const LINES_KEPT = 500;

export const MODES: readonly FleetMode[] = ['ask', 'plan', 'edit', 'run'];
const STATUSES = ['running', 'idle', 'waiting', 'stopped', 'failed'] as const;

export function isMode(m: unknown): m is FleetMode {
  return (MODES as readonly unknown[]).includes(m);
}

export function remoteStatus(s: unknown): SpaceStatus | null {
  return (STATUSES as readonly unknown[]).includes(s)
    ? (s as SpaceStatus)
    : null;
}

/** Only desktops and daemons host spaces; phones and browsers never do. */
export function hosts(kind: string): boolean {
  return kind === 'desktop' || kind === 'daemon';
}

function statusWord(s: SpaceStatus): string {
  return s === 'waiting' ? 'waiting for an answer' : s;
}

const str = (v: unknown, max: number) =>
  typeof v === 'string' ? truncate(v, max) : '';
const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

/** Questions as the UI takes them, shape-checked. */
export function uiQuestions(
  qs: unknown,
): { question: string; options: string[]; multi: boolean }[] {
  if (!Array.isArray(qs)) return [];
  return qs.slice(0, 20).map((q: Partial<RemoteQuestion>) => ({
    question: str(q?.question, 2000),
    options: Array.isArray(q?.options)
      ? q.options
          .filter((o): o is string => typeof o === 'string')
          .slice(0, 20)
          .map((o) => truncate(o, 500))
      : [],
    multi: q?.multi === true,
  }));
}

/** One verified event as a line of history; `null` if it isn't one. */
export function lineOf(seq: number, ev: RemoteSpaceEvent): SpaceLine | null {
  const e = ev as Record<string, unknown>;
  let kind: LineKind;
  let text: string;
  switch (ev?.kind) {
    case 'started':
      kind = 'started';
      text = `Started ${str(e.name, NAME_MAX)} on ${str(e.branch, NAME_MAX)} (${isMode(e.mode) ? e.mode : 'ask'})`;
      break;
    case 'status': {
      const s = remoteStatus(e.status);
      if (!s) return null;
      kind = 'status';
      text = statusWord(s);
      break;
    }
    case 'turn_started':
      kind = 'turn';
      text = `Turn ${num(e.turn)}: ${str(e.text, 2000)}`;
      break;
    case 'tool': {
      kind = 'tool';
      const name = str(e.name, 100);
      const summary = str(e.summary, 200);
      text = summary ? `${name} ${summary}` : name;
      break;
    }
    case 'reply':
      kind = 'reply';
      text = str(e.text, 8000);
      break;
    case 'turn_ended': {
      kind = 'ended';
      const word = ['done', 'stopped', 'failed'].includes(e.outcome as string)
        ? (e.outcome as string)
        : 'done';
      const m = typeof e.message === 'string' ? str(e.message, 2000) : null;
      text = m
        ? `Turn ${num(e.turn)} ${word}: ${m}`
        : `Turn ${num(e.turn)} ${word}`;
      break;
    }
    case 'question':
      kind = 'question';
      text = uiQuestions(e.questions)
        .map((q) => q.question)
        .join(' / ');
      break;
    case 'question_cleared':
      kind = 'question';
      text = 'Question answered or withdrawn';
      break;
    default:
      return null;
  }
  return { seq, kind, text };
}

/** The cloud's word that events `from..=to` are gone: nothing but a line. */
export function gapLine(from: number, to: number): SpaceLine {
  return {
    seq: from,
    kind: 'gap',
    text: `Events ${from}–${to} are no longer available`,
  };
}
