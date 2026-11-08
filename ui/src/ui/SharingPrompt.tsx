import { useEffect, useState } from 'react';
import { Button, Modal } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { TelemetryChoice, TelemetryStatus } from '../gen/contract';
import { api } from '../core/api';
import { useRootStore } from '../stores/context';
import { TelemetryStep } from './Onboarding';
import { WhatsCollectedLink } from './Privacy';

/** Asks once for the sharing choice when it was never made: an install
 *  onboarded before this build could send anything never saw the step,
 *  and nothing is sent until a choice is recorded (docs/telemetry.md). */
export function needsSharingChoice(s: TelemetryStatus): boolean {
  return (
    (s.usage_available && s.usage === null) ||
    (s.errors_available && s.errors === null)
  );
}

/** A switch is on from when the words were "not linked to your account": it
 *  stays anonymous until the user answers (docs/telemetry.md "The choice"). */
export function needsConsent(s: TelemetryStatus): boolean {
  return (
    (s.usage_available && s.usage_needs_consent) ||
    (s.errors_available && s.errors_needs_consent)
  );
}

/** Dismissed for this launch; `sessionStorage` goes with the webview, so a
 *  later launch asks again. */
const CONSENT_DISMISSED = 'theodore.sharing-consent-dismissed';

/** A dialog that isn't this prompt. `ui.modal` covers the named ones; the
 *  rest live in their own components' state, so the DOM is the one place
 *  that knows about them all. */
function otherDialogOpen(): boolean {
  return [
    ...document.querySelectorAll('[role="dialog"],[role="alertdialog"]'),
  ].some((d) => !d.closest('.sharing-prompt'));
}

function useOtherDialogOpen(watch: boolean): boolean {
  const [open, setOpen] = useState(otherDialogOpen);
  useEffect(() => {
    if (!watch) return;
    const id = window.setInterval(() => setOpen(otherDialogOpen()), 1000);
    return () => window.clearInterval(id);
  }, [watch]);
  return open;
}

/** The sharing dialogs: both wait until no other dialog is open, and never
 *  stack on onboarding (the app view renders this only after it). */
export const SharingPrompt = observer(function SharingPrompt() {
  const store = useRootStore();
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [share, setShare] = useState<TelemetryChoice>({
    usage: true,
    errors: true,
  });
  const [saving, setSaving] = useState(false);
  const sandbox = store.ephemeral.sandbox !== null;
  // Linking means an account to link: asked once someone is signed in.
  const signedIn = store.ephemeral.account?.user != null;
  const blocked = useOtherDialogOpen(status !== null);

  useEffect(() => {
    if (sandbox) return;
    let live = true;
    api.telemetryStatus().then(
      (s) => {
        if (!live) return;
        const askConsent =
          signedIn &&
          needsConsent(s) &&
          sessionStorage.getItem(CONSENT_DISMISSED) === null;
        setStatus(needsSharingChoice(s) || askConsent ? s : null);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [sandbox, signedIn]);

  if (!status || store.ui.modal !== null || blocked) return null;

  const record = (choice: TelemetryChoice) => {
    setSaving(true);
    void api
      .setTelemetry(choice)
      .then(() => setStatus(null))
      .catch(() => {
        // toasted by api.ts; the prompt stays
      })
      .finally(() => setSaving(false));
  };

  if (!needsSharingChoice(status)) {
    return (
      <ConsentPrompt
        status={status}
        saving={saving}
        onChoose={record}
        onDismiss={() => {
          sessionStorage.setItem(CONSENT_DISMISSED, '1');
          setStatus(null);
        }}
      />
    );
  }

  const save = (choice: TelemetryChoice) =>
    record({
      usage: status.usage_available && choice.usage,
      errors: status.errors_available && choice.errors,
      usage_consent: true,
      errors_consent: true,
    });

  return (
    <Modal.Backdrop isOpen isDismissable={false}>
      <Modal.Container placement="center">
        <Modal.Dialog
          aria-label="Help improve Theodore"
          className="modal sharing-prompt flex w-[480px] max-w-[92vw] flex-col gap-4 p-6"
        >
          <TelemetryStep status={status} value={share} onChange={setShare} />
          <div className="flex justify-end gap-2">
            <Button
              variant="tertiary"
              isDisabled={saving}
              onPress={() => save({ usage: false, errors: false })}
            >
              Don't share
            </Button>
            <Button
              variant="primary"
              isPending={saving}
              onPress={() => save(share)}
            >
              Save
            </Button>
          </div>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
});

/** The one question for someone who said yes under the old words. Both
 *  answers look the same and neither is preselected; closing it answers
 *  nothing, so what they share stays anonymous and a later launch asks. */
function ConsentPrompt({
  status,
  saving,
  onChoose,
  onDismiss,
}: {
  status: TelemetryStatus;
  saving: boolean;
  onChoose: (choice: TelemetryChoice) => void;
  onDismiss: () => void;
}) {
  const usage = status.usage_available && status.usage_needs_consent;
  const errors = status.errors_available && status.errors_needs_consent;
  const what =
    usage && errors
      ? 'usage data and error reports'
      : usage
        ? 'usage data'
        : 'error reports';
  // Only what was asked about moves; the other switch keeps its answer.
  const keep: TelemetryChoice = {
    usage: status.usage ?? false,
    errors: status.errors ?? false,
    usage_consent: usage,
    errors_consent: errors,
  };
  const stop: TelemetryChoice = {
    usage: usage ? false : (status.usage ?? false),
    errors: errors ? false : (status.errors ?? false),
  };
  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && onDismiss()}>
      <Modal.Container placement="center">
        <Modal.Dialog
          aria-label="Sharing and your account"
          className="modal sharing-prompt flex w-[480px] max-w-[92vw] flex-col gap-3 p-6"
        >
          <Modal.CloseTrigger aria-label="Close" />
          <Modal.Heading className="pe-8">
            Sharing and your account
          </Modal.Heading>
          <p className="text-sm">
            Theodore can now link your {what} to your Theodore account's id, so
            a problem can be matched to the version it happens on. Until you
            choose, {usage && !errors ? 'it stays' : 'they stay'} anonymous.
          </p>
          <div className="flex flex-col gap-1 text-sm text-muted">
            {usage && (
              <span>
                Usage data never carries prompts, code, file paths, repository
                names or your email.
              </span>
            )}
            {errors && (
              <span>
                Error reports drop tokens and emails, and hash repository names
                and file paths.
              </span>
            )}
          </div>
          <WhatsCollectedLink />
          <div className="flex flex-col gap-2">
            <Button
              variant="secondary"
              className="w-full"
              isDisabled={saving}
              onPress={() => onChoose(keep)}
            >
              Keep sharing, linked to my account
            </Button>
            <Button
              variant="secondary"
              className="w-full"
              isDisabled={saving}
              onPress={() => onChoose(stop)}
            >
              Stop sharing
            </Button>
          </div>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
