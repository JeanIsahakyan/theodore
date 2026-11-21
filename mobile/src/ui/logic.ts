/**
 * Screen rules with no React Native: ordering and filtering, mode caps, how
 * answers go on the wire, error text. Mirrors `ui/src/ui/fleet/fleet.ts` on
 * the desktop so both read the same.
 */
import type { FleetMode } from '../gen/fleet';
import type {
  FleetDeviceView,
  QuestionView,
  SpaceLine,
  SpaceStatus,
  SpaceView,
} from '../fleet/types';

/** Least to most powerful: a device's `maxMode` allows every mode up to it. */
export const MODE_ORDER: readonly FleetMode[] = ['ask', 'plan', 'edit', 'run'];

export const MODE_LABEL: Record<FleetMode, string> = {
  ask: 'Ask',
  plan: 'Plan',
  edit: 'Edit',
  run: 'Run',
};

export const MODE_HINT: Record<FleetMode, string> = {
  ask: 'Read only, no edits',
  plan: 'Explore, then a plan to approve before any edit',
  edit: 'Edit files in the space',
  run: 'Edit and run any command',
};

export const RUN_WARNING =
  'Run lets the agent run any command on that computer.';

/** The modes a request to a device capped at `max` may use. */
export function modesUpTo(max: FleetMode): FleetMode[] {
  return MODE_ORDER.slice(0, MODE_ORDER.indexOf(max) + 1);
}

/** `mode` brought down under `max`. */
export function capMode(mode: FleetMode, max: FleetMode): FleetMode {
  return modesUpTo(max).includes(mode) ? mode : max;
}

/** `mode` when `modes` offers it, else the highest offered. */
export function offeredMode(
  modes: readonly FleetMode[],
  mode: FleetMode,
): FleetMode {
  return modes.includes(mode) ? mode : (modes.at(-1) ?? 'ask');
}

/** A row of a sheet's Mode step. */
export interface ModeRow {
  mode: FleetMode;
  label: string;
  /** ✓: the mode in use now. */
  selected: boolean;
}

/** The Mode step: every mode offered, ✓ on `current` (brought under the
 *  cap when it is above it). */
export function modeRows(
  modes: readonly FleetMode[],
  current: FleetMode,
): ModeRow[] {
  const now = offeredMode(modes, current);
  return modes.map((mode) => ({
    mode,
    label: MODE_LABEL[mode],
    selected: mode === now,
  }));
}

/** Devices a space can start on from here: not this one, a computer
 *  (desktop / daemon) you trust, online, taking remote spaces, with a
 *  project to offer. */
export function startableDevices(
  devices: readonly FleetDeviceView[],
): FleetDeviceView[] {
  return devices.filter(
    (d) =>
      !d.thisDevice &&
      (d.kind === 'desktop' || d.kind === 'daemon') &&
      d.trusted &&
      d.online &&
      d.acceptsRemote &&
      d.projects.length > 0,
  );
}

/** Devices as listed: this one first, then online, then by name. */
export function sortDevices(
  devices: readonly FleetDeviceView[],
): FleetDeviceView[] {
  const rank = (d: FleetDeviceView) => (d.thisDevice ? 0 : d.online ? 1 : 2);
  return [...devices].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
  );
}

export const STATUS_LABEL: Record<SpaceStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  idle: 'Idle',
  waiting: 'Waiting for you',
  stopped: 'Stopped',
  failed: 'Failed',
};

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export const STATUS_TONE: Record<SpaceStatus, Tone> = {
  starting: 'neutral',
  running: 'accent',
  idle: 'success',
  waiting: 'warning',
  stopped: 'neutral',
  failed: 'danger',
};

/** The composer works only between turns. */
export const canSend = (s: SpaceStatus): boolean =>
  s === 'idle' || s === 'waiting';

/** Stop is offered while a turn runs. */
export const canStop = (s: SpaceStatus): boolean => s === 'running';

/** A row's title: the space's name, else its branch. */
export const spaceTitle = (s: Pick<SpaceView, 'name' | 'branch'>): string =>
  s.name || s.branch;

/** Waiting for an answer (0), running (1), the rest (2); the store's order
 *  holds inside each group. */
export function spaceRank(s: SpaceView): number {
  if (s.status === 'waiting' || s.question) return 0;
  if (s.status === 'running' || s.status === 'starting') return 1;
  return 2;
}

export function sortSpaces(spaces: readonly SpaceView[]): SpaceView[] {
  return spaces
    .map((s, i) => ({ s, i }))
    .sort((a, b) => spaceRank(a.s) - spaceRank(b.s) || a.i - b.i)
    .map((x) => x.s);
}

/** Markdown the agent wrote, flattened to plain text for a 2-line excerpt. */
export function plainExcerpt(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** History from the store and from `fleet.lines(space)`, one entry per seq
 *  (the store's wins), in order. */
export function mergeLines(
  stored: readonly SpaceLine[],
  loaded: readonly SpaceLine[],
): SpaceLine[] {
  const bySeq = new Map<number, SpaceLine>();
  for (const l of loaded) bySeq.set(l.seq, l);
  for (const l of stored) bySeq.set(l.seq, l);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Who's asking, as the space is named now: a question is often asked
 *  before its space gets its title, so the ask's own `from` (fixed when it
 *  was asked) only stands in for a space this device doesn't follow. */
export function questionFrom(
  q: Pick<QuestionView, 'from' | 'space'>,
  spaces: readonly SpaceView[],
): string {
  const s = spaces.find((x) => x.space === q.space);
  return s ? `${s.hostName} · ${spaceTitle(s)}` : q.from;
}

/** The open question of a space: its own, else a routed one. */
export function questionFor(
  space: SpaceView,
  routed: readonly QuestionView[],
): QuestionView | null {
  return space.question ?? routed.find((q) => q.space === space.space) ?? null;
}

/** One question's answer while it is being picked. */
export interface Draft {
  selected: string[];
  other: string;
}

type Item = QuestionView['questions'][number];

export const emptyDraft = (): Draft => ({ selected: [], other: '' });

/** Picks `option`: toggles it where several may be picked, else makes it
 *  the only answer (and clears "Other"). */
export function pickOption(q: Item, d: Draft, option: string): Draft {
  if (q.multi) {
    return d.selected.includes(option)
      ? { ...d, selected: d.selected.filter((o) => o !== option) }
      : { ...d, selected: [...d.selected, option] };
  }
  return { selected: [option], other: '' };
}

/** Typing under "Other": a single-answer question drops its option. */
export function typeOther(q: Item, d: Draft, text: string): Draft {
  return q.multi ? { ...d, other: text } : { selected: [], other: text };
}

/** Each question has an answer. */
export const isAnswered = (drafts: readonly Draft[]): boolean =>
  drafts.every((d) => d.selected.length > 0 || d.other.trim() !== '');

/** `FleetClient.answer`'s `answers`: per question, the options picked, then
 *  the free text when there is one. */
export function toWireAnswers(drafts: readonly Draft[]): string[][] {
  return drafts.map((d) => {
    const other = d.other.trim();
    return other ? [...d.selected, other] : [...d.selected];
  });
}

/** A failed switch, said plainly: keeps the provider's sentence, drops the
 *  lowercase `area:` prefixes (same as the desktop's AccountCard). */
export function switchErrorText(raw: string): string {
  let s = raw.trim();
  if (/^account: network\b/.test(s)) {
    return "Couldn't switch organization: no connection. Try again.";
  }
  for (
    let m = /^[a-z][a-z_]*\s*:\s*/.exec(s);
    m;
    m = /^[a-z][a-z_]*\s*:\s*/.exec(s)
  ) {
    s = s.slice(m[0].length);
  }
  if (!s) return "Couldn't switch organization.";
  return `Couldn't switch organization. ${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

/** What to do about a fleet refusal, by its code (the words are ours: a
 * refusal's own text isn't trusted). */
const FLEET_HINTS: Record<string, string> = {
  'fleet.untrusted_device':
    "That computer doesn't trust this device yet. On the computer, open Settings → Devices, compare this device's fingerprint and choose Trust.",
  'fleet.upgrade_required':
    'That computer runs an older Theodore. Update it, then try again.',
  'fleet.remote_off':
    'That computer doesn’t take spaces from other devices. Turn it on in its Settings → Devices.',
  'fleet.mode_not_allowed':
    'That computer doesn’t allow this mode. Pick a lower one, or raise its limit in its Settings → Devices.',
  'fleet.offline':
    'That computer is offline. Open Theodore on it and try again.',
  'fleet.busy':
    "The space's queue is full, or its computer can't queue messages yet. Wait until it settles, then send.",
  'fleet.unknown_project': 'That project isn’t on that computer anymore.',
  'fleet.unknown_space': 'That space isn’t on that computer anymore.',
  'fleet.agent_unavailable':
    'That computer doesn’t offer this agent, model or effort any more. Pick another.',
};

/** Any thrown value as a sentence; a fleet refusal by what to do about it. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : null;
  if (raw === null) return 'Something went wrong. Try again.';
  const code = /\bfleet\.[a-z_]+/.exec(raw)?.[0];
  return (code && FLEET_HINTS[code]) || raw;
}

/** "role" → "Role". */
export const roleLabel = (role: string): string =>
  role.charAt(0).toUpperCase() + role.slice(1).replace(/[_-]+/g, ' ');

export const KIND_LABEL: Record<string, string> = {
  desktop: 'Computer',
  daemon: 'Server',
  mobile: 'Phone',
  web: 'Browser',
  mcp: 'Claude via cloud',
};

export const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? kind;

export const OS_LABEL: Record<string, string> = {
  macos: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
  ios: 'iOS',
  android: 'Android',
};

/** "ios" → "iOS"; an OS this build doesn't know, as "other". */
export const osLabel = (os: string): string => OS_LABEL[os] ?? 'other OS';

/** A glyph per device kind (no icon font, so it also renders on web). */
export const KIND_GLYPH: Record<string, string> = {
  desktop: '\u{1F5A5}',
  daemon: '\u{1F5C4}',
  mobile: '\u{1F4F1}',
  web: '\u{1F310}',
};

export const kindGlyph = (kind: string): string =>
  KIND_GLYPH[kind] ?? '\u{25A1}';
