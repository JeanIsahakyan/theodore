import { useEffect, useState } from 'react';
import { Button, Modal } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { TelemetryChoice, TelemetryStatus } from '../gen/contract';
import { api } from '../core/api';
import { useRootStore } from '../stores/context';
import { TelemetryStep } from './Onboarding';

/** Asks once for the sharing choice when it was never made: an install
 *  onboarded before this build could send anything never saw the step,
 *  and nothing is sent until a choice is recorded (docs/telemetry.md). */
export function needsSharingChoice(s: TelemetryStatus): boolean {
  return (
    (s.usage_available && s.usage === null) ||
    (s.errors_available && s.errors === null)
  );
}

export const SharingPrompt = observer(function SharingPrompt() {
  const store = useRootStore();
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [share, setShare] = useState<TelemetryChoice>({
    usage: true,
    errors: true,
  });
  const [saving, setSaving] = useState(false);
  const sandbox = store.ephemeral.sandbox !== null;

  useEffect(() => {
    if (sandbox) return;
    let live = true;
    api.telemetryStatus().then(
      (s) => live && needsSharingChoice(s) && setStatus(s),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [sandbox]);

  if (!status) return null;
  const save = (choice: TelemetryChoice) => {
    setSaving(true);
    void api
      .setTelemetry({
        usage: status.usage_available && choice.usage,
        errors: status.errors_available && choice.errors,
      })
      .then(() => setStatus(null))
      .catch(() => {
        // toasted by api.ts; the prompt stays
      })
      .finally(() => setSaving(false));
  };

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
