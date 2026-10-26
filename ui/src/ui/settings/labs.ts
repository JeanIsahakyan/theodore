/**
 * Settings → Labs: per-machine switches for features still in progress.
 * Each is off until turned on here; off hides the feature everywhere in the
 * UI. What it already made (a GitLab project, an opened review) stays and
 * keeps working — only the ways to add more go away.
 */
import type { HostKind, Setting } from '../../gen/contract';
import { FEATURES } from '../../features';
import type { RootStore } from '../../stores/RootStore';

export const LINEAR_LAB = 'labs.linear';
export const GITLAB_LAB = 'labs.gitlab';
export const BITBUCKET_LAB = 'labs.bitbucket';

/** The Labs page's rows, in order. */
export const LABS = [
  {
    key: LINEAR_LAB,
    title: 'Linear',
    text: 'Settings → Integrations for a Linear API key, and the linked issues as chips in the preview and the review Overview tab.',
    note: 'In spaces, your Claude Linear connector works too: Settings → Agents → Allow my Claude MCP servers in spaces.',
  },
  {
    key: GITLAB_LAB,
    title: 'GitLab',
    text: 'GitLab sign-in in Settings → Account, its repositories in Add project, and gitlab.com merge request links.',
  },
  {
    key: BITBUCKET_LAB,
    title: 'Bitbucket',
    text: 'Bitbucket sign-in in Settings → Account, its repositories in Add project, and bitbucket.org pull request links.',
  },
] as const;

type Settings = Pick<Setting, 'key' | 'scope' | 'value'>[];

/** `settings` rows are `{ key, scope, value }`; only the user scope counts,
 *  and anything but an explicit `true` is off. */
export function labOn(settings: Settings, key: string): boolean {
  return settings.some(
    (s) => s.key === key && s.scope === 'user' && s.value === true,
  );
}

/** Hosts behind a lab; the rest (GitHub, local folders) are always on. */
const HOST_LAB: Partial<Record<HostKind, string>> = {
  gitlab: GITLAB_LAB,
  bitbucket: BITBUCKET_LAB,
};

export function hostOn(settings: Settings, host: HostKind): boolean {
  const key = HOST_LAB[host];
  return !key || labOn(settings, key);
}

/** Linear needs both the build flag and the lab. */
export function linearOn(flag: boolean, settings: Settings): boolean {
  return flag && labOn(settings, LINEAR_LAB);
}

export function isLinearOn(store: RootStore): boolean {
  return linearOn(FEATURES.linear, store.models.settings.all());
}

export function isHostOn(store: RootStore, host: HostKind): boolean {
  return hostOn(store.models.settings.all(), host);
}
