/**
 * What is broken right now, at the top of the main area — one banner at a
 * time, most urgent first. Offline wins over auth, which wins over rate
 * limiting: there is no point telling someone their token is bad while the
 * network itself is down.
 */
import { useEffect, useState } from 'react';
import { Alert, Button } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { HostStatus } from '../../stores/EphemeralStore';
import type { SyncStatus } from '../../sync/SyncClient';
import { useRootStore, useUi } from '../../stores/context';
import { Spinner } from '../bits';

export type StatusKind = 'offline' | 'auth' | 'rate' | null;

/** Pure so it is cheap to unit-test: which banner (if any) applies right now. */
export function statusKind(
  syncStatus: SyncStatus,
  host: HostStatus,
  now: number,
): StatusKind {
  if (syncStatus === 'error' || !host.online) return 'offline';
  if (!host.authOk) return 'auth';
  if (host.rateLimitedUntil !== null && host.rateLimitedUntil > now) {
    return 'rate';
  }
  return null;
}

function formatCountdown(ms: number): string {
  const mins = Math.ceil(ms / 60_000);
  if (mins <= 1) return 'under a minute';
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
}

/** Re-renders once a second while mounted — just enough for a countdown. */
function useNow(activeMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (activeMs === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [activeMs]);
  return now;
}

export const StatusBanners = observer(function StatusBanners() {
  const store = useRootStore();
  const ui = useUi();
  const [retrying, setRetrying] = useState(false);
  const host = store.ephemeral.hostStatus;
  const now = useNow(host.rateLimitedUntil);
  const kind = statusKind(store.sync.status, host, now);

  if (kind === 'offline') {
    const pending = store.sync.queue.pending.length;
    return (
      <Alert
        status="warning"
        className="status-banner status-offline rounded-none border-b border-separator"
      >
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Offline</Alert.Title>
          <Alert.Description>
            Diff, drafts and agents keep working locally.{' '}
            {pending > 0
              ? `${pending} ${pending === 1 ? 'write is' : 'writes are'} queued and will go out once reconnected.`
              : 'Anything you do will be queued and sent automatically.'}
          </Alert.Description>
        </Alert.Content>
        <Button
          size="sm"
          variant="tertiary"
          className="retry-connection"
          isPending={retrying}
          onPress={() => {
            setRetrying(true);
            void store.sync.retry().finally(() => setRetrying(false));
          }}
        >
          {retrying && <Spinner />}
          Retry
        </Button>
      </Alert>
    );
  }

  if (kind === 'auth') {
    return (
      <Alert
        status="danger"
        className="status-banner status-auth rounded-none border-b border-separator"
      >
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>GitHub sign-in failed</Alert.Title>
          <Alert.Description>
            The saved token was rejected — reconnect to keep writes going.
          </Alert.Description>
        </Alert.Content>
        <Button
          size="sm"
          variant="tertiary"
          className="reconnect-host"
          onPress={() => ui.go({ name: 'settings', page: 'account' })}
        >
          Reconnect
        </Button>
      </Alert>
    );
  }

  if (kind === 'rate') {
    return (
      <Alert
        status="warning"
        className="status-banner status-rate rounded-none border-b border-separator"
      >
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>GitHub rate limit reached</Alert.Title>
          <Alert.Description>
            Resets in {formatCountdown(host.rateLimitedUntil! - now)}. Reads
            fall back to cached data until then.
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  return null;
});
