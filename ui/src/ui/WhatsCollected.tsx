/** "What's collected": every usage event with its fields, and what is
 *  never sent — straight from the core's list, so it can't drift. */
import { useEffect, useState } from 'react';
import type { TelemetryStatus } from '../gen/contract';
import { api } from '../core/api';
import { useUi } from '../stores/context';
import { Shell, Spinner } from './bits';

/** The one claim the UI makes about usage data, everywhere it's shown. */
export const TELEMETRY_CLAIM =
  'Not linked to your account, email or code; repository names are hashed; you can turn this off any time in Settings.';

export function WhatsCollectedView({ status }: { status: TelemetryStatus }) {
  return (
    <div className="whats-collected flex flex-col gap-4 text-sm">
      <span className="text-muted">{TELEMETRY_CLAIM}</span>
      <section className="flex flex-col gap-1.5">
        <span className="font-medium">Usage events</span>
        <ul className="telemetry-events flex flex-col gap-1">
          {status.events.map((e) => (
            <li key={e.name} className="font-mono text-xs">
              <span className="text-foreground">{e.name}</span>
              {e.fields.length > 0 && (
                <span className="text-muted"> {e.fields.join(', ')}</span>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-1.5">
        <span className="font-medium">Never sent</span>
        <ul className="telemetry-never flex list-disc flex-col gap-1 ps-5 text-muted">
          {status.never_sent.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function WhatsCollectedModal() {
  const ui = useUi();
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api.telemetryStatus().then(
      (s) => live && setStatus(s),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <Shell title="What's collected" onClose={() => ui.closeModal()}>
      {status ? (
        <WhatsCollectedView status={status} />
      ) : failed ? (
        <span className="text-sm text-muted">Couldn't load the list.</span>
      ) : (
        <Spinner />
      )}
    </Shell>
  );
}
