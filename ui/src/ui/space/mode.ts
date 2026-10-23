/** Build mode against the live store: on/off, Labs visibility, and the
 *  "turn done" notices. No React, so `RootStore` can start the watcher. */
import { reaction } from 'mobx';
import type { Space } from '../../gen/contract';
import { notify, setBadge } from '../../core/native';
import { FEATURES } from '../../features';
import type { RootStore } from '../../stores/RootStore';
import { spaceSeen } from './seen';
import {
  buildModeOn,
  labsVisible,
  nativeNotice,
  notifyOn,
  turnEnded,
  waitingSpaces,
} from './spaces';

export function isBuildMode(store: RootStore): boolean {
  return buildModeOn(FEATURES.buildMode, store.models.settings.all());
}

export function isLabsVisible(store: RootStore): boolean {
  return labsVisible(FEATURES.buildMode, store.models.settings.all());
}

/** Whether you can see the window at all (not just the app's tab). */
const windowFocused = () =>
  typeof document === 'undefined' || document.hasFocus();

/** A finished turn: a toast for a space you're not looking at, and — with
 *  the window in the background and `spaces.notify` on — a system
 *  notification. Coming back to the window (clicking the notification
 *  does that) opens the space it was about. The dock badge counts the
 *  spaces waiting for you. */
export function watchSpaceTurns(store: RootStore): () => void {
  let prev = new Map<string, Space>();
  /** The space the last background notification was about. */
  let pending: string | null = null;

  const turns = reaction(
    () => store.models.spaces.all().map((s) => ({ ...s })),
    (spaces) => {
      if (isBuildMode(store)) {
        for (const s of spaces) {
          const before = prev.get(s.id);
          const route = store.ui.route;
          const looking = route.name === 'space' && route.id === s.id;
          const away = !windowFocused();
          const native = nativeNotice(before, s);
          if (native && away && notifyOn(store.models.settings.all())) {
            void notify(native.title, native.body).catch(() => {});
            pending = s.id;
          }
          const notice = turnEnded(before, s);
          if (!notice || (looking && !away)) continue;
          store.ephemeral.toast(notice.text, notice.level, {
            label: 'Open',
            onAction: () => store.ui.go({ name: 'space', id: s.id }),
          });
        }
      }
      prev = new Map(spaces.map((s) => [s.id, s]));
    },
  );

  const onFocus = () => {
    const id = pending;
    pending = null;
    if (id && store.models.spaces.get(id) && isBuildMode(store)) {
      store.ui.go({ name: 'space', id });
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);

  const badge = reaction(
    () =>
      isBuildMode(store)
        ? waitingSpaces(store.models.spaces.all(), (id) => spaceSeen.get(id))
        : 0,
    (n) => void setBadge(n).catch(() => {}),
    { fireImmediately: true },
  );

  return () => {
    turns();
    badge();
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', onFocus);
    }
  };
}
