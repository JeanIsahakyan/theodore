/**
 * Every product event the app may send, with the properties it may carry
 * (docs/telemetry.md "Mobile"). `track()` drops an event not listed here
 * and any property not in its list; `test/telemetry-catalog.test.ts` checks
 * that every call in the source names one of these with a literal.
 *
 * Values are counts, durations, flags, codes or values from a fixed set:
 * never code, paths, titles, names or anyone's words.
 */

export interface CatalogEvent {
  /** What the event answers. */
  answers: string;
  props: readonly string[];
}

export const CATALOG = {
  app_started: {
    answers: 'Is the app used, on what version, cold or warm?',
    props: ['cold'],
  },
  signed_in: { answers: 'Do people get past sign-in?', props: ['how'] },
  sign_in_failed: {
    answers: 'Why does sign-in fail?',
    props: ['reason'],
  },
  signed_out: { answers: 'How often do people sign out?', props: [] },
  org_switched: { answers: 'Are organizations switched?', props: ['ok'] },
  consent_changed: {
    answers: 'What do people choose to share?',
    props: ['usage', 'errors', 'where'],
  },
  screen_viewed: { answers: 'Which screens are used?', props: ['screen'] },
  fleet_connected: {
    answers: 'Does the fleet link come up, how fast, after how many tries?',
    props: ['welcome_ms', 'attempts', 'protocol', 'resumed'],
  },
  fleet_disconnected: {
    answers: 'Why does the link go?',
    props: ['reason', 'code', 'connected_ms'],
  },
  fleet_request: {
    answers: 'Do requests to computers succeed, how fast?',
    props: ['op', 'target_kind', 'ms', 'outcome', 'code', 'over'],
  },
  push_registered: {
    answers: 'Does push registration work?',
    props: ['outcome', 'reason'],
  },
  notification_opened: {
    answers: 'Are notifications tapped, which actions?',
    props: ['action', 'outcome'],
  },
  space_started: {
    answers: 'Where do spaces start, in which mode, how fast, why refused?',
    props: [
      'computer_kind',
      'mode',
      'agent',
      'model',
      'effort',
      'ms',
      'outcome',
      'code',
    ],
  },
  message_sent: {
    answers: 'Do sends land, queued or not, how fast, after how many retries?',
    props: ['surface', 'kind', 'queued', 'ms', 'retries', 'outcome', 'code'],
  },
  question_answered: {
    answers: 'Do answers reach the computer?',
    props: ['surface', 'over', 'outcome', 'code', 'questions'],
  },
  plan_decided: {
    answers: 'Are plans approved or revised?',
    props: ['decision'],
  },
  pick_made: {
    answers: 'Which agents, models, efforts and modes are picked, where?',
    props: ['what', 'surface', 'agent', 'model', 'effort', 'mode'],
  },
  sheet_opened: { answers: 'Which sheets are opened?', props: ['kind'] },
  activity_used: {
    answers: 'Is the activity strip used?',
    props: ['what'],
  },
  sub_space_opened: {
    answers: 'Are sub-spaces opened from the phone?',
    props: ['from'],
  },
  sub_space_read_failed: {
    answers: 'Does reading a sub-space fail, why?',
    props: ['code'],
  },
  saved_spaces_restored: {
    answers: 'How many spaces come back at start, how fast?',
    props: ['count', 'ms'],
  },
  space_stopped: {
    answers: 'Do people stop spaces from the phone?',
    props: ['outcome', 'code'],
  },
  queued_message: {
    answers: 'Do people send now or remove queued messages from the phone?',
    props: ['action', 'outcome', 'code'],
  },
  space_archived: {
    answers: 'Do people archive (and undo) from the phone, why refused?',
    props: ['action', 'surface', 'stopped_first', 'outcome', 'code'],
  },
  device_trusted: {
    answers: 'Are computers trusted from the phone?',
    props: ['trusted', 'kind'],
  },
  confirm_answered: {
    answers: "Are Claude via cloud's requests allowed or denied here?",
    props: ['allow', 'over', 'outcome', 'code'],
  },
  // File transfer (fleet protocol v8): what the attach / upload / viewer
  // flows report once they land; never a file name or path.
  file_attached: {
    answers: 'Are files attached to messages, of what kind and size?',
    props: ['source', 'media', 'bytes', 'count', 'outcome', 'code'],
  },
  file_uploaded: {
    answers:
      'Do uploads to the blob store finish, how fast, in how many chunks?',
    props: ['bytes', 'chunks', 'ms', 'outcome', 'code', 'retries'],
  },
  file_viewed: {
    answers:
      'Are received files opened (the viewer, a step thumbnail), and does the download work?',
    props: ['media', 'bytes', 'ms', 'outcome', 'code', 'surface'],
  },
  diagnostics_exported: {
    answers: 'Is the local log exported for a report?',
    props: ['how', 'records'],
  },
  slow_render: {
    answers: 'Which screens render slowly?',
    props: ['screen', 'ms'],
  },
} as const satisfies Record<string, CatalogEvent>;

export type EventName = keyof typeof CATALOG;

export type EventProps<E extends EventName> = Partial<
  Record<(typeof CATALOG)[E]['props'][number], string | number | boolean | null>
>;

export const EVENT_NAMES = Object.keys(CATALOG) as EventName[];

export function isCatalogEvent(name: string): name is EventName {
  return Object.prototype.hasOwnProperty.call(CATALOG, name);
}

/** `props` with anything the catalog doesn't list for `event` dropped. */
export function allowedProps(
  event: EventName,
  props: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const allowed: readonly string[] = CATALOG[event].props;
  const out: Record<string, string | number | boolean | null> = {};
  for (const name of allowed) {
    const v = props[name];
    if (v === undefined) continue;
    if (v === null || typeof v === 'boolean' || typeof v === 'number') {
      out[name] = v;
    } else if (typeof v === 'string') {
      out[name] = v.slice(0, 100);
    }
  }
  return out;
}

/** What is never sent, one line each ("What's collected"). */
export const NEVER_SENT: readonly string[] = [
  'Your messages, goals, answers or anything an agent wrote',
  'Code, diffs, file contents or file paths',
  'Space titles, project names and computer names (hashed with a key unique to this install in error reports; absent from usage data)',
  'Your email, name or login (signed in, only the account’s opaque id)',
  'Tokens, passwords or other credentials',
  'Debug logs (they stay in the local log on this device)',
];

/** The event list "What's collected" shows. */
export function catalogRows(): { name: string; fields: string[] }[] {
  return EVENT_NAMES.map((name) => ({
    name,
    fields: [...CATALOG[name].props],
  }));
}
