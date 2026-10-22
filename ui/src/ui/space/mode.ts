/** Build mode against the live store: on/off, Labs visibility, and the
 *  "turn done" notices. No React, so `RootStore` can start the watcher. */
import { reaction } from 'mobx';
import type { Space } from '../../gen/contract';
import { FEATURES } from '../../features';
import type { RootStore } from '../../stores/RootStore';
import { buildModeOn, labsVisible, turnEnded } from './spaces';

export function isBuildMode(store: RootStore): boolean {
  return buildModeOn(FEATURES.buildMode, store.models.settings.all());
}

export function isLabsVisible(store: RootStore): boolean {
  return labsVisible(FEATURES.buildMode, store.models.settings.all());
}

/** Toasts "turn done" / "turn failed" for a space you're not looking at. */
export function watchSpaceTurns(store: RootStore): () => void {
  let prev = new Map<string, Space>();
  return reaction(
    () => store.models.spaces.all().map((s) => ({ ...s })),
    (spaces) => {
      if (isBuildMode(store)) {
        for (const s of spaces) {
          const notice = turnEnded(prev.get(s.id), s);
          const route = store.ui.route;
          const looking = route.name === 'space' && route.id === s.id;
          if (!notice || looking) continue;
          store.ephemeral.toast(notice.text, notice.level, {
            label: 'Open',
            onAction: () => store.ui.go({ name: 'space', id: s.id }),
          });
        }
      }
      prev = new Map(spaces.map((s) => [s.id, s]));
    },
  );
}
