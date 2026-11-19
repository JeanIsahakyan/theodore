/** Fleet UI rules with no React: which devices can take a space, which
 *  modes they allow, how answers go on the wire (docs/fleet.md). */
import type {
  FleetAuto,
  FleetConfirm,
  FleetDevice,
  FleetQuestionItem,
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

/** A phone, the web app (docs/mobile.md) or Claude via the cloud: a
 *  client only. It starts, steers and answers spaces on your computers, and
 *  never runs one. */
export const isClient = (d: Pick<FleetDevice, 'kind'>): boolean =>
  d.kind === 'mobile' || d.kind === 'web' || d.kind === 'mcp';

/** Claude via the cloud (MCP): its key is held by the Theodore cloud, so
 *  an Edit or Run from it waits for your yes on the computer. */
export const isCloudClaude = (d: Pick<FleetDevice, 'kind'>): boolean =>
  d.kind === 'mcp';

/** A phone, the web app or another desktop computer: what may follow this
 *  computer's spaces and get its Claude via cloud prompts. */
export const canFollow = (d: Pick<FleetDevice, 'kind'>): boolean =>
  d.kind === 'mobile' || d.kind === 'web' || d.kind === 'desktop';

/** The one-line warning shown wherever Claude via the cloud is trusted. */
export const CLOUD_CLAUDE_WARNING =
  'Its key is held by the Theodore cloud, not by a device of yours. It can ask and plan here; an Edit or Run from it waits for your yes on this computer, unless you turn on auto mode.';

/** Auto mode, least to most: what each lets Claude via cloud skip. */
export const AUTO_ORDER: readonly FleetAuto[] = ['off', 'edit', 'full'];

export const AUTO_LABEL: Record<FleetAuto, string> = {
  off: 'Off',
  edit: 'Auto Edit',
  full: 'Full auto',
};

/** The warning while auto mode is on, or about to be. */
export function autoWarning(auto: FleetAuto): string {
  return `Its key is held by the Theodore cloud: with auto on, the cloud could make this computer edit${auto === 'full' ? ' and run commands' : ''} without you.`;
}

/** How long a new auto mode lasts. */
export type AutoDuration = 'hour' | 'day' | 'off';

export const AUTO_DURATIONS: readonly { id: AutoDuration; label: string }[] = [
  { id: 'hour', label: '1 hour' },
  { id: 'day', label: 'Until end of day' },
  { id: 'off', label: 'Until I turn it off' },
];

/** `until_ms` for a duration picked at `now`: an hour, the end of today
 *  (local), or none. */
export function autoUntil(d: AutoDuration, now: number): number | null {
  if (d === 'hour') return now + 60 * 60 * 1000;
  if (d === 'day') {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return end.getTime();
  }
  return null;
}

/** "until 18:00", "until Nov 21, 09:00", "until turned off". */
export function untilLabel(until: number | null | undefined, now: number) {
  if (until == null) return 'until turned off';
  const at = new Date(until);
  const time = at.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (at.toDateString() === new Date(now).toDateString()) {
    return `until ${time}`;
  }
  const day = at.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `until ${day}, ${time}`;
}

/** An auto mode still on at `now` (its end not passed). */
export const autoOn = (
  auto: FleetAuto | undefined,
  until: number | null | undefined,
  now: number,
): boolean => !!auto && auto !== 'off' && (until == null || until > now);

const OS_LABEL: Partial<Record<FleetDevice['os'], string>> = {
  macos: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
};

/** What a device is, for people: "Phone", "Web app", "Claude via cloud
 *  (MCP)", else its OS. */
export function kindLabel(d: Pick<FleetDevice, 'kind' | 'os'>): string {
  if (d.kind === 'mobile') return 'Phone';
  if (d.kind === 'web') return 'Web app';
  if (d.kind === 'mcp') return 'Claude via cloud (MCP)';
  const os = OS_LABEL[d.os] ?? 'Computer';
  return d.kind === 'daemon' ? `${os} server` : os;
}

/** Devices a space can be started on from here: another computer you
 *  trust (its key is pinned here, so what it sends back is checked),
 *  online, taking remote spaces and with a project to offer. Never a
 *  phone or the web app, whatever it lists. */
export function startableDevices(
  devices: readonly FleetDevice[],
): FleetDevice[] {
  return devices.filter(
    (d) =>
      !d.this_device &&
      !isClient(d) &&
      d.trusted &&
      d.online &&
      d.accepts_remote &&
      d.projects.length > 0,
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

/** What a request waiting for your yes would do, after "Claude via cloud
 *  wants to": "start an Edit space in app", "send to Fix login in Run",
 *  "approve the plan in Fix login (Edit)". */
export function confirmAction(c: FleetConfirm): string {
  const mode = MODE_LABEL[c.mode];
  const space = c.space_name ?? 'a space';
  switch (c.action) {
    case 'start':
      return `start ${/^[AEIOU]/.test(mode) ? 'an' : 'a'} ${mode} space in ${c.project_name ?? 'a project'}`;
    case 'approve_plan':
      return `approve the plan in ${space} (${mode})`;
    case 'send':
      return `send to ${space} in ${mode}`;
  }
}
