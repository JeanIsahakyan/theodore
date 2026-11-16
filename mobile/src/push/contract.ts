/**
 * The push contract between the Theodore cloud and this app, as pure TS (no
 * Expo imports, so vitest runs it). `src/push/index.ts` is the thin Expo layer;
 * `src/push/README.md` explains the choices. The cloud mirrors
 * `askPresentation` when it builds a push.
 */

/** Body limit the cloud keeps (docs/mobile.md). */
export const MAX_BODY = 180;
/** Most options a push carries in `data.options`. */
export const MAX_OPTIONS = 4;
/** Most option buttons: Android shows three action buttons, iOS up to four. */
export const MAX_OPTION_BUTTONS = 3;

/** Action identifiers registered in the categories. */
export const ACTION_REPLY = 'reply';
export const ACTION_OPEN = 'open';
export const optionAction = (i: number) => `opt${i}`;

/**
 * Category ids (no `:` or `-`, Expo warns they misbehave):
 *  - `ask_opt2`: buttons "1" "2" + Reply
 *  - `ask_opt3`: buttons "1" "2" "3"
 *  - `ask_text`: Reply + Open (free text, or options that don't fit as buttons)
 */
export const CATEGORY_TEXT = 'ask_text';
export const optionCategory = (n: number) => `ask_opt${n}`;

export type PushKind = 'ask' | 'finished';

/** `data` of every push the cloud sends. */
export interface PushData {
  kind: PushKind;
  /** Only for `kind: "ask"`. */
  ask_id: string;
  space: string;
  host_device: string;
  /** The first question's options, at most 4; empty for a free-text question. */
  options: string[];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Validates an untrusted `data` object; null if it isn't one of ours. */
export function parsePushData(raw: unknown): PushData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Record<string, unknown>;
  const kind = d.kind;
  if (kind !== 'ask' && kind !== 'finished') return null;
  const space = str(d.space);
  const hostDevice = str(d.host_device);
  if (!space || !hostDevice) return null;
  const askId = str(d.ask_id);
  if (kind === 'ask' && !askId) return null;
  const options = Array.isArray(d.options)
    ? d.options
        .filter((o): o is string => typeof o === 'string' && o.length > 0)
        .slice(0, MAX_OPTIONS)
    : [];
  return {
    kind,
    ask_id: askId ?? '',
    space,
    host_device: hostDevice,
    options,
  };
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

const MIN_QUESTION = 60;

/**
 * Body and category for an ask with one single-choice or free-text question.
 * Option buttons are static ("1", "2", "3"), so the body lists what the
 * numbers mean. Options that don't fit, or more than three, fall back to
 * `ask_text`. Asks with several questions or multi-select get no category at
 * all (the cloud omits `categoryId`): they are answered in the app.
 */
export function askPresentation(
  question: string,
  options: string[],
): { body: string; categoryId: string } {
  const opts = options.slice(0, MAX_OPTIONS);
  if (opts.length >= 2 && opts.length <= MAX_OPTION_BUTTONS) {
    // Leave MIN_QUESTION for the question; split the rest between the options.
    const label = Math.floor(
      (MAX_BODY - MIN_QUESTION - 1 - 2 * (opts.length - 1)) / opts.length - 3,
    );
    const list = opts
      .map((o, i) => `${i + 1}) ${truncate(o, label)}`)
      .join('  ');
    const room = MAX_BODY - list.length - 1;
    if (room >= MIN_QUESTION) {
      return {
        body: `${truncate(question, room)}\n${list}`,
        categoryId: optionCategory(opts.length),
      };
    }
  }
  return { body: truncate(question, MAX_BODY), categoryId: CATEGORY_TEXT };
}

/** What to do with a notification response. */
export type ResponseAction =
  | {
      type: 'answer';
      space: string;
      askId: string;
      hostDevice: string;
      answers: string[][];
    }
  | { type: 'open'; space: string }
  | { type: 'ignore' };

/** Longest free-text reply we send. */
export const MAX_REPLY = 2000;

/** One question answered with one value: `[[value]]`. */
export function shapeAnswer(value: string): string[][] {
  return [[value]];
}

/**
 * Maps a tap / button / text reply to an action. Anything that can't be
 * answered safely (a tap, unknown button, empty text, a `finished` push)
 * degrades to opening the space rather than guessing.
 */
export function classifyResponse(input: {
  actionIdentifier: string;
  userText?: string | null;
  data: unknown;
}): ResponseAction {
  const data = parsePushData(input.data);
  if (!data) return { type: 'ignore' };
  const open: ResponseAction = { type: 'open', space: data.space };
  if (data.kind !== 'ask') return open;

  const answer = (a: string): ResponseAction => ({
    type: 'answer',
    space: data.space,
    askId: data.ask_id,
    hostDevice: data.host_device,
    answers: shapeAnswer(a),
  });

  const id = input.actionIdentifier;
  if (id === ACTION_REPLY) {
    const text = (input.userText ?? '').trim().slice(0, MAX_REPLY);
    return text ? answer(text) : open;
  }
  const m = /^opt(\d)$/.exec(id);
  if (m) {
    const picked = data.options[Number(m[1])];
    return picked ? answer(picked) : open;
  }
  return open;
}

/** Route a tap opens. */
export function spacePath(space: string): string {
  return `/space/${encodeURIComponent(space)}`;
}

/** Same response never handled twice (listener + cold-start replay). */
export function responseKey(
  notificationId: string,
  actionIdentifier: string,
): string {
  return `${notificationId}|${actionIdentifier}`;
}

/** Banner while the app is open, unless the user is already in that space. */
export function showInForeground(
  data: unknown,
  activeSpace: string | null,
): boolean {
  const d = parsePushData(data);
  return !(d && activeSpace !== null && d.space === activeSpace);
}
