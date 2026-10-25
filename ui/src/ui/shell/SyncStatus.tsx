/** Sync state: synced, syncing (n pending transactions), or offline. The
 *  sidebar shows it in the workspace switcher — the logo's stripes move
 *  and the name reads "Syncing…" — rather than in a footer line. */
import { useEffect, useState } from 'react';
import type { HostStatus } from '../../stores/EphemeralStore';
import type { SyncStatus as SyncClientStatus } from '../../sync/SyncClient';
import { useRootStore } from '../../stores/context';

export type SyncIndicator = {
  label: string;
  dot: 'success' | 'warning' | 'danger';
  detail: string;
};

/** Pure so the three states are simple to unit-test without mounting React. */
export function syncIndicator(
  status: SyncClientStatus,
  host: HostStatus,
  pending: number,
): SyncIndicator {
  if (status === 'error' || !host.online) {
    return {
      label: 'Offline',
      dot: 'danger',
      detail: 'Not connected — writes are queued locally.',
    };
  }
  if (status === 'bootstrapping' || pending > 0) {
    return {
      label: pending > 0 ? `Syncing (${pending})` : 'Syncing',
      dot: 'warning',
      detail:
        pending > 0
          ? `${pending} ${pending === 1 ? 'change is' : 'changes are'} still being sent.`
          : 'Loading the latest state.',
    };
  }
  return { label: 'Synced', dot: 'success', detail: 'Up to date.' };
}

/** Show "syncing" only once it has lasted a beat, and keep it up for a
 *  moment: a send that takes a few milliseconds would otherwise flicker
 *  the switcher's name. */
const SHOW_AFTER_MS = 400;
const HOLD_MS = 900;

/** What the sidebar's workspace switcher shows instead of a footer line:
 *  the syncing logo and label while a sync is visibly under way, a dimmed
 *  logo while offline (the offline banner says the rest). */
export function useSyncDisplay(): {
  syncing: boolean;
  offline: boolean;
  detail: string;
} {
  const store = useRootStore();
  const info = syncIndicator(
    store.sync.status,
    store.ephemeral.hostStatus,
    store.sync.queue.pending.length,
  );
  const busy = info.dot === 'warning';
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (busy === shown) return;
    const t = setTimeout(() => setShown(busy), busy ? SHOW_AFTER_MS : HOLD_MS);
    return () => clearTimeout(t);
  }, [busy, shown]);
  return {
    syncing: shown,
    offline: info.dot === 'danger',
    detail: info.detail,
  };
}
