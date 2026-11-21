/** Decisions the fleet waits on you for, one centered dialog at a time
 *  (docs/fleet.md "Auto mode and remote prompts"): a request from Claude
 *  via cloud (here, or on a computer that sends you its prompts) and a
 *  device asking to run spaces here. Several queue, "1 of 3". Esc or a
 *  click outside puts the dialog away unanswered; the tab bar then keeps a
 *  "2 waiting" reminder that opens it again (`FleetChrome`). */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  ShieldExclamation,
} from '@gravity-ui/icons';
import { Button, Modal } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { FleetConfirm, FleetTrustNeeded } from '../../gen/contract';
import { notifySpace } from '../../core/native';
import { useRootStore } from '../../stores/context';
import type { FleetStore } from '../../stores/FleetStore';
import { K } from '../bits';
import { useNow } from '../space/BackgroundTasks';
import { CLOUD_CLAUDE_WARNING, confirmAction } from './fleet';
import {
  CLOUD_CLAUDE,
  CLOUD_KEY_NOTE,
  confirmTextLabel,
  countdown,
  pendingPrompts,
  type PendingPrompt,
} from './prompts';
import { Fingerprint, TrustConfirm } from './TrustConfirm';

/** "start an Edit space in app", "… on Studio Mac" when it waits there. */
const what = (c: FleetConfirm) =>
  c.host_name ? `${confirmAction(c)} on ${c.host_name}` : confirmAction(c);

/** The queue as the dialog and the reminder see it at `now`, and whether
 *  the dialog is up: some prompt in it wasn't put away. */
export function promptQueue(fleet: FleetStore, now: number) {
  const queue = fleet.available
    ? pendingPrompts(fleet.confirmList, fleet.trustNeededList, now)
    : [];
  const fresh = queue.filter((p) => !fleet.promptsAway.has(p.key));
  return { queue, open: fresh.length > 0, firstFresh: fresh[0] };
}

/** Away from the window, the system says a request came (a click brings
 *  the window up), once per request. */
function useRequestNotifications(confirms: readonly FleetConfirm[]) {
  const told = useRef(new Set<string>());
  const ids = confirms.map((c) => c.id).join(' ');
  useEffect(() => {
    for (const c of confirms) {
      if (told.current.has(c.id)) continue;
      told.current.add(c.id);
      if (document.hasFocus()) continue;
      void notifySpace(
        c.local_space ?? '',
        `${CLOUD_CLAUDE} wants to ${what(c)}`,
        c.text,
      ).catch(() => false);
    }
    // Once per new request: the ids are what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
}

export const FleetPrompts = observer(function FleetPrompts() {
  const fleet = useRootStore().fleet;
  const confirms = fleet.confirmList;
  // A live countdown, and a request out of time closes on its own.
  useNow(confirms.length > 0);
  useRequestNotifications(fleet.available ? confirms : []);
  const [curKey, setCurKey] = useState<string | null>(null);
  const focusRef = useRef<HTMLDivElement>(null);
  const { queue, open, firstFresh } = promptQueue(fleet, Date.now());
  const cur = queue.find((p) => p.key === curKey) ?? firstFresh ?? queue[0];
  // Each prompt starts with focus on no button: Enter answers nothing.
  useEffect(() => {
    if (open) focusRef.current?.focus({ preventScroll: true });
  }, [open, cur?.key]);
  if (!open || !cur) return null;
  const index = queue.indexOf(cur);
  const nav = (
    <QueueNav
      index={index}
      total={queue.length}
      onMove={(d) => setCurKey(queue[index + d]?.key ?? cur.key)}
    />
  );
  const label =
    cur.kind === 'confirm'
      ? `${CLOUD_CLAUDE} wants to ${what(cur.request)}`
      : `${cur.request.device_name} wants to run spaces here`;
  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(o) => {
        if (!o) fleet.putAwayPrompts(queue.map((p) => p.key));
      }}
    >
      <Modal.Container placement="center" scroll="inside">
        <Modal.Dialog
          role="alertdialog"
          aria-label={label}
          className="modal fleet-prompt flex max-h-[84vh] w-[520px] max-w-[92vw] flex-col gap-3 p-5"
          data-prompt={cur.key}
        >
          <Modal.CloseTrigger aria-label="Decide later" />
          <div
            ref={focusRef}
            tabIndex={-1}
            className="flex min-h-0 flex-1 flex-col gap-3 outline-none"
          >
            <PromptBody key={cur.key} prompt={cur} nav={nav} />
          </div>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
});

function PromptBody({
  prompt,
  nav,
}: {
  prompt: PendingPrompt;
  nav: ReactNode;
}) {
  return prompt.kind === 'confirm' ? (
    <ConfirmPrompt request={prompt.request} nav={nav} />
  ) : (
    <TrustPrompt request={prompt.request} nav={nav} />
  );
}

/** "1 of 3" with the previous and next prompt; nothing for one. */
function QueueNav({
  index,
  total,
  onMove,
}: {
  index: number;
  total: number;
  onMove: (delta: number) => void;
}) {
  if (total < 2) return <span />;
  return (
    <div className="fleet-prompt-nav flex items-center gap-0.5 text-xs text-muted">
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label="Previous request"
        className="size-7 min-w-7"
        isDisabled={index === 0}
        onPress={() => onMove(-1)}
      >
        <ChevronLeft className="size-3.5" />
      </Button>
      <span className="fleet-prompt-count tabular-nums">
        {index + 1} of {total}
      </span>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label="Next request"
        className="size-7 min-w-7"
        isDisabled={index === total - 1}
        onPress={() => onMove(1)}
      >
        <ChevronRight className="size-3.5" />
      </Button>
    </div>
  );
}

function PromptHead({
  icon,
  title,
  sub,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <div className="flex items-start gap-3 pe-8">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-warning-soft text-warning [&>svg]:size-4">
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <Modal.Heading className="text-base font-semibold [overflow-wrap:anywhere]">
          {title}
        </Modal.Heading>
        <span className="text-xs text-muted">{sub}</span>
      </div>
    </div>
  );
}

/** Nothing runs until Allow; Deny, or no answer before the request's
 *  window ends, refuses it (`fleet.denied`). The goal or message is
 *  plain text. Allow takes a click or ⌘⏎, never a bare Enter. */
const ConfirmPrompt = observer(function ConfirmPrompt({
  request,
  nav,
}: {
  request: FleetConfirm;
  nav: ReactNode;
}) {
  const fleet = useRootStore().fleet;
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const answer = (allow: boolean) => {
    if (busy) return;
    setBusy(allow ? 'allow' : 'deny');
    void fleet
      .confirm(request.id, allow)
      .catch(() => {
        // toasted by api.ts; the prompt goes either way
      })
      .finally(() => setBusy(null));
  };
  const answerRef = useRef(answer);
  answerRef.current = answer;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      answerRef.current(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const host = request.host_name;
  const left = request.expires_at_ms - Date.now();
  const at = new Date(request.expires_at_ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <div
      className="fleet-request-confirm flex min-h-0 flex-1 flex-col gap-3"
      data-request={request.id}
    >
      <PromptHead
        icon={<Cloud />}
        title={`${CLOUD_CLAUDE} wants to ${what(request)}`}
        sub={`From ${request.device_name}`}
      />
      <p
        role="note"
        className="fleet-mcp-warning rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground"
      >
        {host ? CLOUD_KEY_NOTE : CLOUD_CLAUDE_WARNING}
      </p>
      {host && (
        <span className="fleet-request-host text-sm">
          Waiting on <span className="font-medium">{host}</span>. Your answer
          goes there.
        </span>
      )}
      <div className="flex min-h-0 flex-col gap-1">
        <span className="text-xs font-medium text-muted">
          {confirmTextLabel(request)}
        </span>
        <p className="fleet-request-text max-h-60 min-h-0 overflow-y-auto whitespace-pre-wrap rounded-md bg-default px-3 py-2 text-sm [overflow-wrap:anywhere]">
          {request.text}
        </p>
      </div>
      <span className="fleet-request-countdown text-xs text-muted">
        Refused automatically in{' '}
        <span className="tabular-nums">{countdown(left)}</span> (at {at}) unless
        you allow it.
      </span>
      <div className="flex shrink-0 items-center gap-2">
        {nav}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="secondary"
          className="fleet-request-deny"
          isDisabled={busy !== null}
          isPending={busy === 'deny'}
          onPress={() => answer(false)}
        >
          Deny
        </Button>
        <Button
          size="sm"
          variant="primary"
          className="fleet-request-allow gap-1.5"
          isDisabled={busy !== null}
          isPending={busy === 'allow'}
          onPress={() => answer(true)}
        >
          Allow <K>⌘⏎</K>
        </Button>
      </div>
    </div>
  );
});

/** "<device> wants to run spaces here": Trust opens the same fingerprint
 *  check as Settings → Devices, and only its button pins the key — the
 *  one this prompt's fingerprint is of. Dismiss answers it with no. */
const TrustPrompt = observer(function TrustPrompt({
  request,
  nav,
}: {
  request: FleetTrustNeeded;
  nav: ReactNode;
}) {
  const fleet = useRootStore().fleet;
  const [confirming, setConfirming] = useState(false);
  const name = request.device_name;
  return (
    <div
      className="fleet-trust-needed flex flex-col gap-3"
      data-device={request.device_id}
    >
      <PromptHead
        icon={<ShieldExclamation />}
        title={`${name} wants to run spaces here`}
        sub="It isn't trusted on this computer."
      />
      {confirming ? (
        <TrustConfirm
          deviceId={request.device_id}
          name={name}
          fingerprint={request.fingerprint}
          publicKey={request.public_key}
          kind={request.kind}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Fingerprint</span>
            <Fingerprint value={request.fingerprint} />
          </div>
          <span className="text-xs text-muted">
            Compare it with what {name} shows before you trust it.
          </span>
          {request.kind === 'mcp' && (
            <p
              role="note"
              className="fleet-mcp-warning rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground"
            >
              {CLOUD_CLAUDE} (MCP). {CLOUD_CLAUDE_WARNING}
            </p>
          )}
          <div className="flex shrink-0 items-center gap-2">
            {nav}
            <span className="flex-1" />
            <Button
              size="sm"
              variant="secondary"
              className="fleet-trust-dismiss"
              onPress={() => fleet.dismissTrustNeeded(request.device_id)}
            >
              Dismiss
            </Button>
            <Button
              size="sm"
              variant="primary"
              className="fleet-trust-accept"
              onPress={() => setConfirming(true)}
            >
              Trust…
            </Button>
          </div>
        </>
      )}
    </div>
  );
});
