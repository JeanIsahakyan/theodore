/** What the fleet puts in front of you wherever you are (docs/fleet.md):
 *  questions of agents on other devices, routed to this one, and devices
 *  that asked to run a space here without being trusted. */
import { useState } from 'react';
import { ShieldExclamation } from '@gravity-ui/icons';
import { Button, Card } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { FleetTrustNeeded } from '../../gen/contract';
import { useRootStore, useUi } from '../../stores/context';
import { FleetQuestionCard } from './FleetQuestionCard';
import { Fingerprint, TrustConfirm } from './TrustConfirm';

/** "<device> wants to run spaces here": Trust opens the same fingerprint
 *  check as Settings → Devices, and only its button pins the key — the one
 *  this notice's fingerprint is of. */
export const TrustNeededCard = observer(function TrustNeededCard({
  request,
}: {
  request: FleetTrustNeeded;
}) {
  const fleet = useRootStore().fleet;
  const [confirming, setConfirming] = useState(false);
  return (
    <Card
      role="status"
      className="fleet-trust-needed flex flex-col gap-2 border border-warning/40 p-3 shadow-lg"
      data-device={request.device_id}
    >
      <div className="flex items-start gap-2">
        <ShieldExclamation className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm">
            <span className="font-medium">{request.device_name}</span> wants to
            run spaces here — fingerprint{' '}
            <Fingerprint value={request.fingerprint} />
          </span>
          {!confirming && (
            <span className="text-xs text-muted">
              Compare it with what {request.device_name} shows before you trust
              it.
            </span>
          )}
        </div>
      </div>
      {confirming ? (
        <TrustConfirm
          deviceId={request.device_id}
          name={request.device_name}
          fingerprint={request.fingerprint}
          publicKey={request.public_key}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="fleet-trust-dismiss"
            onPress={() => fleet.dismissTrustNeeded(request.device_id)}
          >
            Dismiss
          </Button>
          <Button
            size="sm"
            className="fleet-trust-accept"
            onPress={() => setConfirming(true)}
          >
            Trust
          </Button>
        </div>
      )}
    </Card>
  );
});

export const FleetNotices = observer(function FleetNotices() {
  const store = useRootStore();
  const ui = useUi();
  const fleet = store.fleet;
  if (!fleet.available) return null;
  const route = ui.route;
  // The space's own page already shows its question.
  const asks = fleet.askList.filter(
    (q) => !(route.name === 'fleet-space' && route.id === q.space),
  );
  const trusts = fleet.trustNeededList;
  if (asks.length === 0 && trusts.length === 0) return null;
  return (
    <div className="fleet-notices pointer-events-none absolute right-4 top-12 z-30 flex max-h-[75vh] w-[420px] max-w-[calc(100%-2rem)] flex-col gap-2 overflow-auto [&>*]:pointer-events-auto">
      {trusts.map((r) => (
        <TrustNeededCard key={r.device_id} request={r} />
      ))}
      {asks.map((q) => (
        <FleetQuestionCard
          key={q.ask_id}
          question={q}
          className="bg-surface shadow-lg"
        />
      ))}
    </div>
  );
});
