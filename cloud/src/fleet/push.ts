/**
 * Push notifications through the Expo Push API (docs/mobile.md "Cloud"): no
 * APNs or FCM keys in the Worker, Expo holds them for the app.
 *
 * ```text
 * hub ─▶ PushMessage[] ─▶ POST https://exp.host/--/api/v2/push/send (≤ 100 a call)
 *     ◀─ tickets, one per message: ok │ error{details.error}
 *        DeviceNotRegistered ─▶ the hub drops that token
 * ```
 *
 * Only what the phone shows travels: names the cloud verified or stored, a
 * question cut to 180 chars, its option labels. Never a token in a log.
 */
import type { FleetMode, RemoteConfirm } from '../gen/fleet';

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * One notification for one device, in Expo's message shape, as the app's
 * push contract wants it (mobile/src/push/README.md): no sound, Android
 * channel `default`, `data.kind` `ask`, `finished` or `confirm`.
 */
export interface PushMessage {
  to: string;
  title: string;
  body: string;
  /** A category the app registered (its buttons); absent: tap only. */
  categoryId?: string;
  channelId: 'default';
  priority?: 'high';
  data: {
    kind: 'ask' | 'finished' | 'confirm';
    /** '' unless `ask`. */
    ask_id: string;
    /** '' for `confirm`. */
    space: string;
    host_device: string;
    /** The question's options (≤ 4); `opt<i>` answers `options[i]`. */
    options: string[];
    status?: string;
    /** `confirm`: the host's `RemoteConfirm.confirm_id`. */
    confirm_id?: string;
  };
}

/** What happened to one message: sent, the token is dead, or it failed. */
export type PushResult = 'ok' | 'unregistered' | 'failed';

/** Sends a batch; one result per message, in order. Never throws. */
export type PushSender = (msgs: PushMessage[]) => Promise<PushResult[]>;

const BATCH = 100;

/** The Expo Push API through `fetch` (injectable for tests). */
export function expoSender(
  fetchFn: typeof fetch,
  accessToken?: string,
): PushSender {
  return async (msgs) => {
    const out: PushResult[] = [];
    for (let i = 0; i < msgs.length; i += BATCH) {
      const batch = msgs.slice(i, i + BATCH);
      out.push(...(await sendBatch(fetchFn, batch, accessToken)));
    }
    return out;
  };
}

async function sendBatch(
  fetchFn: typeof fetch,
  batch: PushMessage[],
  accessToken?: string,
): Promise<PushResult[]> {
  const failed = batch.map((): PushResult => 'failed');
  let res: Response;
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    res = await fetchFn(EXPO_PUSH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(batch),
    });
  } catch (e) {
    console.error('fleet.push', e instanceof Error ? e.name : typeof e);
    return failed;
  }
  if (!res.ok) {
    console.error('fleet.push', `http ${res.status}`);
    return failed;
  }
  let tickets: unknown;
  try {
    tickets = ((await res.json()) as { data?: unknown }).data;
  } catch {
    return failed;
  }
  if (!Array.isArray(tickets)) return failed;
  return batch.map((_, i) => ticketResult(tickets[i]));
}

function ticketResult(t: unknown): PushResult {
  if (t === null || typeof t !== 'object') return 'failed';
  const ticket = t as { status?: unknown; details?: { error?: unknown } };
  if (ticket.status === 'ok') return 'ok';
  return ticket.details?.error === 'DeviceNotRegistered'
    ? 'unregistered'
    : 'failed';
}

const MODE_LABEL: Record<FleetMode, string> = {
  ask: 'Ask',
  plan: 'Plan',
  edit: 'Edit',
  run: 'Run',
};

/** "an Edit", "a Plan": the mode label with its article. */
const withArticle = (mode: FleetMode) =>
  `${mode === 'ask' || mode === 'edit' ? 'an' : 'a'} ${MODE_LABEL[mode]}`;

/**
 * The push for a request from Claude via the cloud waiting on its host
 * (docs/cloud.md "Push notifications"). The phone app registers category
 * `confirm` with two buttons, Allow and Deny: each sends a signed
 * `RemoteOp::Confirm{confirm_id, allow}` to `data.host_device`. Keep this
 * shape exactly:
 *
 * ```text
 * title       "Claude via cloud · <host name>"
 * body        "wants to <what>: <text>", ≤ 180 chars
 * categoryId  confirm      priority high      channelId default
 * data        {kind: confirm, confirm_id, host_device, space: "", ask_id: "", options: []}
 * ```
 */
export function confirmPush(
  hostName: string,
  c: RemoteConfirm,
): Omit<PushMessage, 'to'> {
  const mode = MODE_LABEL[c.mode];
  const space = c.space_name ?? 'a space';
  const what =
    c.action === 'start'
      ? `start ${withArticle(c.mode)} space in ${c.project_name ?? 'a project'}`
      : c.action === 'send'
        ? `send to ${space} in ${mode}`
        : c.action === 'merge'
          ? `merge a sub-space into ${space}`
          : `approve the plan in ${space} (${mode})`;
  const text = c.text.trim();
  return {
    title: clip(`Claude via cloud · ${hostName}`, 120),
    body: clip(
      text ? `wants to ${what}: ${text}` : `wants to ${what}`,
      MAX_BODY,
    ),
    categoryId: 'confirm',
    channelId: 'default',
    priority: 'high',
    data: {
      kind: 'confirm',
      confirm_id: c.confirm_id,
      host_device: c.host_device,
      space: '',
      ask_id: '',
      options: [],
    },
  };
}

/** On one line, at most `max` chars, an ellipsis when cut. */
export function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

// ── the app's presentation of a question (a port, kept equal by test) ──────
//
// Mirrors `askPresentation` in mobile/src/push/contract.ts: the app's
// categories have fixed buttons ("1", "2", "3"), so the body lists what the
// numbers mean. test/fleet-push.test.ts checks both give the same output.

const MAX_BODY = 180;
const MAX_OPTIONS = 4;
/** Android shows three action buttons: the cap on both platforms. */
const MAX_OPTION_BUTTONS = 3;
const MIN_QUESTION = 60;

/** Body and category for one single-choice or free-text question. */
export function askPresentation(
  question: string,
  options: string[],
): { body: string; categoryId: string } {
  const opts = options.slice(0, MAX_OPTIONS);
  if (opts.length >= 2 && opts.length <= MAX_OPTION_BUTTONS) {
    // MIN_QUESTION stays for the question; the rest is split between options.
    const label = Math.floor(
      (MAX_BODY - MIN_QUESTION - 1 - 2 * (opts.length - 1)) / opts.length - 3,
    );
    const list = opts.map((o, i) => `${i + 1}) ${clip(o, label)}`).join('  ');
    const room = MAX_BODY - list.length - 1;
    if (room >= MIN_QUESTION) {
      return {
        body: `${clip(question, room)}\n${list}`,
        categoryId: `ask_opt${opts.length}`,
      };
    }
  }
  return { body: clip(question, MAX_BODY), categoryId: 'ask_text' };
}
