/**
 * What the MCP device may hand a model, and how: the same rules as the
 * phone (`mobile/src/fleet/rules.ts`) and the desktop core
 * (`crates/app/src/usecases/fleet*.rs`). Refusals are codes only; names
 * from the cloud's (unsigned) listing are cut to a safe alphabet; texts
 * come from events and replies a pinned computer signed.
 */
import type { FleetMode, RemoteQuestion, RemoteSpaceEvent } from '../gen/fleet';

/** `^dev_[0-9a-f-]{36}$`: a device id as the cloud issues it. */
export function validDeviceId(id: unknown): id is string {
  return typeof id === 'string' && /^dev_[0-9a-f-]{36}$/.test(id);
}

/** `rs_` and 32 hex: a space id this device makes. */
export function validSpaceId(id: unknown): id is string {
  return typeof id === 'string' && /^rs_[0-9a-f]{32}$/.test(id);
}

/** A project id as an agent may see and name it (`fleet_tools.rs`). */
export function validProjectId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    /^[A-Za-z0-9._:/@+-]{1,100}$/.test(id) &&
    id.split(':').length <= 5
  );
}

const NAME_MAX = 40;

/**
 * A device name as pinned: only `[A-Za-z0-9 ._()-]`, ≤ 40 characters,
 * `device` when nothing is left (the cloud's listing is unsigned).
 */
export function pinName(name: string): string {
  const kept = [...name]
    .filter((c) => /^[A-Za-z0-9 ._()-]$/.test(c))
    .slice(0, NAME_MAX)
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

export const MODES: readonly FleetMode[] = ['ask', 'plan', 'edit', 'run'];
const STATUSES = ['running', 'idle', 'waiting', 'stopped', 'failed'] as const;

export function isMode(m: unknown): m is FleetMode {
  return (MODES as readonly unknown[]).includes(m);
}

export function remoteStatus(s: unknown): string | null {
  return (STATUSES as readonly unknown[]).includes(s) ? (s as string) : null;
}

/** Only desktops and daemons host spaces; phones, browsers and MCP never do. */
export function hosts(kind: string): boolean {
  return kind === 'desktop' || kind === 'daemon';
}

const str = (v: unknown, max: number) =>
  typeof v === 'string' ? truncate(v, max) : '';
const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

export interface QuestionView {
  question: string;
  options: string[];
  multi: boolean;
}

/** Questions shape-checked and bounded. */
export function uiQuestions(qs: unknown): QuestionView[] {
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

export interface Line {
  seq: number;
  kind: string;
  text: string;
}

/** One verified event as a line of history; `null` if it isn't one. */
export function lineOf(seq: number, ev: RemoteSpaceEvent): Line | null {
  const e = ev as Record<string, unknown>;
  let kind: string;
  let text: string;
  switch (ev?.kind) {
    case 'started':
      kind = 'started';
      text = `Started ${str(e.name, 200)} on ${str(e.branch, 200)} (${isMode(e.mode) ? e.mode : 'ask'})`;
      break;
    case 'status': {
      const s = remoteStatus(e.status);
      if (!s) return null;
      kind = 'status';
      text = s === 'waiting' ? 'waiting for an answer' : s;
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
export function gapLine(from: number, to: number): Line {
  return {
    seq: from,
    kind: 'gap',
    text: `Events ${from}–${to} are no longer available`,
  };
}
