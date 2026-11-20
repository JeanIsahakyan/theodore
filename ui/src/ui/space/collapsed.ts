/** Which spaces' sub-spaces the sidebar hides — local only, like the seen
 *  marks. Open by default: what an agent started is what you want to see. */
import { observable, runInAction } from 'mobx';
import { STORAGE_NS } from '../../stores/UiStore';

const LS_COLLAPSED = `${STORAGE_NS}theodore-space-collapsed`;

function load(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS_COLLAPSED) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export const collapsedSpaces = observable.set<string>(load());

export function toggleSubSpaces(id: string): void {
  runInAction(() => {
    if (collapsedSpaces.has(id)) collapsedSpaces.delete(id);
    else collapsedSpaces.add(id);
  });
  localStorage.setItem(LS_COLLAPSED, JSON.stringify([...collapsedSpaces]));
}
