/** Fleet UI rules with no React: which devices can take a space, which
 *  modes they allow, how a status reads, how answers go on the wire
 *  (docs/fleet.md). */
import type {
  FleetDevice,
  FleetQuestionItem,
  FleetRemoteSpace,
  FleetSpaceStatus,
  SpaceMode,
} from '../../gen/contract';

/** Least to most powerful: a device's `max_mode` allows every mode up to it. */
export const MODE_ORDER: readonly SpaceMode[] = ['ask', 'plan', 'edit', 'run'];

export const MODE_LABEL: Record<SpaceMode, string> = {
  ask: 'Ask',
  plan: 'Plan',
  edit: 'Edit',
  run: 'Run',
};

export const MODE_HINT: Record<SpaceMode, string> = {
  ask: 'Read only, no edits',
  plan: 'Explore, then a plan to approve before any edit',
  edit: 'Edit files in the space',
  run: 'Edit and run any command',
};

/** The modes a request to a device capped at `max` may use. */
export function modesUpTo(max: SpaceMode): SpaceMode[] {
  return MODE_ORDER.slice(0, MODE_ORDER.indexOf(max) + 1);
}

/** `mode` brought down under `max`. */
export function capMode(mode: SpaceMode, max: SpaceMode): SpaceMode {
  return modesUpTo(max).includes(mode) ? mode : max;
}

/** Devices a space can be started on from here: another device that is
 *  online, takes remote spaces and has a project to offer. */
export function startableDevices(
  devices: readonly FleetDevice[],
): FleetDevice[] {
  return devices.filter(
    (d) =>
      !d.this_device && d.online && d.accepts_remote && d.projects.length > 0,
  );
}

/** Shown under Devices: "online", "seen 3 min ago", "never seen". */
export function lastSeenLabel(
  ms: number,
  online: boolean,
  now: number,
): string {
  if (online) return 'online';
  if (!ms) return 'never seen';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'seen just now';
  const m = Math.round(s / 60);
  if (m < 60) return `seen ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `seen ${h} h ago`;
  return `seen ${Math.round(h / 24)} days ago`;
}

export const STATUS_LABEL: Record<FleetSpaceStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  idle: 'Idle',
  waiting: 'Waiting for you',
  stopped: 'Stopped',
  failed: 'Failed',
};

export type StatusColor =
  'default' | 'accent' | 'success' | 'warning' | 'danger';

export const STATUS_COLOR: Record<FleetSpaceStatus, StatusColor> = {
  starting: 'default',
  running: 'accent',
  idle: 'success',
  waiting: 'warning',
  stopped: 'default',
  failed: 'danger',
};

/** The composer works only between turns. */
export const canSend = (s: FleetSpaceStatus): boolean =>
  s === 'idle' || s === 'waiting';

/** Stop is offered while a turn runs. */
export const canStop = (s: FleetSpaceStatus): boolean => s === 'running';

/** The goal of a list row: the space's name, on whichever device. */
export const spaceTitle = (s: FleetRemoteSpace): string => s.name || s.branch;

/** One question's answer while you pick it. */
export interface Draft {
  selected: string[];
  other: string;
}

export const emptyDraft = (): Draft => ({ selected: [], other: '' });

/** Picks `option`: toggles it where several may be picked, else makes it
 *  the only answer (and clears "Other"). */
export function pickOption(
  q: FleetQuestionItem,
  d: Draft,
  option: string,
): Draft {
  if (q.multi) {
    return d.selected.includes(option)
      ? { ...d, selected: d.selected.filter((o) => o !== option) }
      : { ...d, selected: [...d.selected, option] };
  }
  return { selected: [option], other: '' };
}

/** Typing under "Other": a single-answer question drops its option. */
export function typeOther(q: FleetQuestionItem, d: Draft, text: string): Draft {
  return q.multi ? { ...d, other: text } : { selected: [], other: text };
}

/** Each question has an answer. */
export const isAnswered = (drafts: readonly Draft[]): boolean =>
  drafts.every((d) => d.selected.length > 0 || d.other.trim() !== '');

/** `FleetAnswerRequest.answers`: per question, the options picked, then
 *  the free text when there is one. */
export function toWireAnswers(drafts: readonly Draft[]): string[][] {
  return drafts.map((d) => {
    const other = d.other.trim();
    return other ? [...d.selected, other] : [...d.selected];
  });
}
