/** "Connecting…" / the connection's error; nothing while connected or off. */
import { useFleetState } from '../state/fleet';
import { Notice } from './kit';

export function ConnectionBanner() {
  const connection = useFleetState((s) => s.connection);
  const error = useFleetState((s) => s.error);
  if (connection === 'connecting') {
    return <Notice tone="warning">Connecting to your devices…</Notice>;
  }
  if (connection === 'error') {
    return (
      <Notice tone="danger">
        {error ? `Not connected: ${error}` : 'Not connected.'}
      </Notice>
    );
  }
  return null;
}
