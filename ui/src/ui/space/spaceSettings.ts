/**
 * The `spaces.*` settings a project may override (docs/spaces.md §7
 * "Auto-archive", "Sub-spaces"): what each one is, its built-in default, and
 * how a value resolves — the project's own row (`project:<id>`), else the
 * user's (`user`, Settings → Spaces), else the default. The core reads them
 * the same way (`settings.rs`, `setting_value_for_project`).
 */
import type { Setting } from '../../gen/contract';

export type SpaceSettingKey =
  | 'spaces.auto_archive_days'
  | 'spaces.auto_archive_merged'
  | 'spaces.max_children'
  | 'spaces.max_depth'
  | 'spaces.ask_timeout_secs';

export type SpaceSettingSpec =
  | {
      key: SpaceSettingKey;
      kind: 'number';
      label: string;
      hint: string;
      default: number;
      /** A unit shown after the value in summaries (`days`, `s`). */
      unit?: string;
      accept: (n: number) => boolean;
    }
  | {
      key: SpaceSettingKey;
      kind: 'boolean';
      label: string;
      hint: string;
      default: boolean;
    };

const nonNegativeInt = (n: number) => n >= 0 && Number.isInteger(n);
const positiveInt = (n: number) => n >= 1 && Number.isInteger(n);

/** In the order both pages list them. */
export const SPACE_SETTINGS: readonly SpaceSettingSpec[] = [
  {
    key: 'spaces.auto_archive_days',
    kind: 'number',
    label: 'Auto-archive after (days)',
    hint: 'Days after a space’s PR merges, or it is merged locally or kept as a branch, before it archives itself. 0 = never.',
    default: 7,
    unit: 'days',
    accept: nonNegativeInt,
  },
  {
    key: 'spaces.auto_archive_merged',
    kind: 'boolean',
    label: 'Archive merged spaces automatically',
    hint: 'A space whose PR merged archives itself after the days above, once it is idle with nothing unshipped and no live sub-spaces. Off keeps merged spaces until you archive them.',
    default: true,
  },
  {
    key: 'spaces.max_children',
    kind: 'number',
    label: 'Max sub-spaces per space',
    hint: 'Live (not archived, not done) sub-spaces a space’s agent may have at once.',
    default: 5,
    accept: nonNegativeInt,
  },
  {
    key: 'spaces.max_depth',
    kind: 'number',
    label: 'Max sub-space depth',
    hint: 'How deep sub-spaces nest; a top-level space is 0, so 1 allows children but no grandchildren.',
    default: 2,
    accept: nonNegativeInt,
  },
  {
    key: 'spaces.ask_timeout_secs',
    kind: 'number',
    label: 'Ask timeout (seconds)',
    hint: 'How long a space’s agent waits for another space’s answer to space_ask.',
    default: 180,
    unit: 's',
    accept: positiveInt,
  },
];

export const specOf = (key: SpaceSettingKey): SpaceSettingSpec =>
  SPACE_SETTINGS.find((s) => s.key === key)!;

/** The setting scope of a project's own overrides (`Project::id`). */
export const projectScope = (project: string): string => `project:${project}`;

export type SpaceSettingSource = 'project' | 'user' | 'default';

export const SPACE_SOURCE_LABEL: Record<SpaceSettingSource, string> = {
  project: 'This project',
  user: 'Global',
  default: 'Default',
};

type Row = Pick<Setting, 'key' | 'scope' | 'value'>;

/** A row's value if it is of the setting's kind and accepted; a stored
 *  value of the wrong shape counts as unset. */
function valid(spec: SpaceSettingSpec, v: unknown): number | boolean | null {
  if (spec.kind === 'boolean') return typeof v === 'boolean' ? v : null;
  return typeof v === 'number' && Number.isFinite(v) && spec.accept(v)
    ? v
    : null;
}

function rowValue(
  settings: readonly Row[],
  key: string,
  scope: string,
): unknown {
  return settings.find((s) => s.key === key && s.scope === scope)?.value;
}

/** The value in effect for `project` (or, with none, for every project
 *  without an override) and where it comes from. */
export function effectiveSpaceSetting(
  settings: readonly Row[],
  key: SpaceSettingKey,
  project?: string | null,
): { value: number | boolean; source: SpaceSettingSource } {
  const spec = specOf(key);
  if (project) {
    const own = valid(spec, rowValue(settings, key, projectScope(project)));
    if (own !== null) return { value: own, source: 'project' };
  }
  const user = valid(spec, rowValue(settings, key, 'user'));
  if (user !== null) return { value: user, source: 'user' };
  return { value: spec.default, source: 'default' };
}

/** The project's own override of `key`, `undefined` when it has none. */
export function projectOverride(
  settings: readonly Row[],
  key: SpaceSettingKey,
  project: string,
): number | boolean | undefined {
  const v = valid(specOf(key), rowValue(settings, key, projectScope(project)));
  return v === null ? undefined : v;
}

/** The value as the rows show it: `7 days`, `On`, `180 s`. */
export function formatSpaceSetting(
  key: SpaceSettingKey,
  value: number | boolean,
): string {
  const spec = specOf(key);
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (spec.kind === 'number' && spec.unit) return `${value} ${spec.unit}`;
  return String(value);
}
