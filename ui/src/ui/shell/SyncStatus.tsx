/** Small sync indicator for the sidebar footer: synced, syncing (n pending
 *  transactions), or offline — the same three states Linear's own client
 *  shows in its sidebar. */
import { observer } from 'mobx-react-lite';
import { Tooltip } from '@heroui/react';
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

const DOT_CLASS: Record<SyncIndicator['dot'], string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

export const SyncStatus = observer(function SyncStatus() {
  const store = useRootStore();
  const info = syncIndicator(
    store.sync.status,
    store.ephemeral.hostStatus,
    store.sync.queue.pending.length,
  );
  return (
    <Tooltip>
      <span className="sync-status flex items-center gap-1.5 text-xs text-muted">
        <span
          className={`size-1.5 shrink-0 rounded-full ${DOT_CLASS[info.dot]}`}
        />
        {info.label}
      </span>
      <Tooltip.Content>{info.detail}</Tooltip.Content>
    </Tooltip>
  );
});
