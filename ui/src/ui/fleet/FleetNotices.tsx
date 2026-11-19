/** What the fleet puts in front of you wherever you are (docs/fleet.md):
 *  auto modes on now, requests from Claude via the cloud waiting for your
 *  yes (here, or on a computer that sends you its prompts), questions of
 *  agents on other devices, routed to this one, and devices that asked to
 *  run a space here without being trusted. */
import { useEffect, useState } from 'react';
import { Cloud, ShieldExclamation } from '@gravity-ui/icons';
import { Button, Card } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type {
  FleetAutoOn,
  FleetConfirm,
  FleetTrustNeeded,
} from '../../gen/contract';
import { notifySpace } from '../../core/native';
import { useRootStore, useUi } from '../../stores/context';
import {
  AUTO_LABEL,
  CLOUD_CLAUDE_WARNING,
  autoOn,
  confirmAction,
  untilLabel,
} from './fleet';
import { FleetQuestionCard } from './FleetQuestionCard';
import { Fingerprint, TrustConfirm } from './TrustConfirm';

const CLOUD_CLAUDE = 'Claude via cloud';

/** "Claude via cloud wants to start an Edit space in app: <goal>", with
 *  Allow / Deny. Nothing runs until Allow; Deny, or no answer before the
 *  request's window ends, refuses it (`fleet.denied`). The goal or
 *  message is shown as plain text. */
export const ConfirmCard = observer(function ConfirmCard({
  request,
}: {
  request: FleetConfirm;
}) {
  const fleet = useRootStore().fleet;
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  // Waiting on another computer that sends its prompts here: say which.
  const what = request.host_name
    ? `${confirmAction(request)} on ${request.host_name}`
    : confirmAction(request);
  // Away from the window: the system says so too (a click brings it up).
  useEffect(() => {
    if (document.hasFocus()) return;
    void notifySpace(
      request.local_space ?? '',
      `${CLOUD_CLAUDE} wants to ${what}`,
      request.text,
    ).catch(() => false);
    // Once per request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id]);
  const answer = (allow: boolean) => {
    setBusy(allow ? 'allow' : 'deny');
    void fleet
      .confirm(request.id, allow)
      .catch(() => {
        // toasted by api.ts; the prompt goes either way
      })
      .finally(() => setBusy(null));
  };
  const until = new Date(request.expires_at_ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <Card
      role="alertdialog"
      aria-label={`${CLOUD_CLAUDE} wants to ${what}`}
      className="fleet-request-confirm flex flex-col gap-2 border border-warning/40 p-3 shadow-lg"
      data-request={request.id}
    >
      <div className="flex items-start gap-2">
        <Cloud className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm">
            <span className="font-medium">{CLOUD_CLAUDE}</span> wants to {what}:
          </span>
          <p className="fleet-request-text line-clamp-6 whitespace-pre-wrap rounded-md bg-default px-2 py-1 text-sm [overflow-wrap:anywhere]">
            {request.text}
          </p>
          <span className="text-xs text-muted">
            From {request.device_name}.{' '}
            {request.host_name
              ? `Your answer goes to ${request.host_name}.`
              : CLOUD_CLAUDE_WARNING}{' '}
            Unanswered by {until}, it is refused.
          </span>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="fleet-request-deny"
          isDisabled={busy !== null}
          isPending={busy === 'deny'}
          onPress={() => answer(false)}
        >
          Deny
        </Button>
        <Button
          size="sm"
          className="fleet-request-allow"
          isDisabled={busy !== null}
          isPending={busy === 'allow'}
          onPress={() => answer(true)}
        >
          Allow
        </Button>
      </div>
    </Card>
  );
});

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
          {!confirming && request.kind === 'mcp' && (
            <span
              role="note"
              className="fleet-mcp-warning text-xs text-warning"
            >
              {CLOUD_CLAUDE} (MCP). {CLOUD_CLAUDE_WARNING}
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
          kind={request.kind}
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

/** "Claude via cloud: full auto until 18:00 · Turn off", while it lasts. */
export const AutoBanner = observer(function AutoBanner({
  auto,
}: {
  auto: FleetAutoOn;
}) {
  const fleet = useRootStore().fleet;
  const [busy, setBusy] = useState(false);
  const label = AUTO_LABEL[auto.auto].toLowerCase();
  return (
    <Card
      role="status"
      className="fleet-auto-on flex flex-row items-center gap-2 border border-warning/40 px-3 py-2 shadow-lg"
      data-device={auto.device_id}
    >
      <Cloud aria-hidden className="size-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-1 text-sm">
        <span className="font-medium">{CLOUD_CLAUDE}</span>: {label}{' '}
        {untilLabel(auto.until_ms, Date.now())}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="fleet-auto-off"
        isPending={busy}
        onPress={() => {
          setBusy(true);
          void fleet
            .setAuto({
              device_id: auto.device_id,
              auto: 'off',
              until_ms: null,
              host_device: null,
            })
            .catch(() => {
              // toasted by api.ts
            })
            .finally(() => setBusy(false));
        }}
      >
        Turn off
      </Button>
    </Card>
  );
});

export const FleetNotices = observer(function FleetNotices() {
  const store = useRootStore();
  const ui = useUi();
  const fleet = store.fleet;
  if (!fleet.available) return null;
  const route = ui.route;
  // The space's own page already shows its question (a remote space's id
  // is its fleet id).
  const asks = fleet.askList.filter(
    (q) => !(route.name === 'space' && route.id === q.space),
  );
  const trusts = fleet.trustNeededList;
  const confirms = fleet.confirmList;
  const now = Date.now();
  const autos = fleet.autos.filter((a) => autoOn(a.auto, a.until_ms, now));
  if (
    asks.length === 0 &&
    trusts.length === 0 &&
    confirms.length === 0 &&
    autos.length === 0
  ) {
    return null;
  }
  return (
    <div className="fleet-notices pointer-events-none absolute right-4 top-12 z-30 flex max-h-[75vh] w-[420px] max-w-[calc(100%-2rem)] flex-col gap-2 overflow-auto [&>*]:pointer-events-auto">
      {autos.map((a) => (
        <AutoBanner key={a.device_id} auto={a} />
      ))}
      {confirms.map((c) => (
        <ConfirmCard key={c.id} request={c} />
      ))}
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
