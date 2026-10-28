import { ArrowRotateRight } from '@gravity-ui/icons';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { api } from '../../core/api';
import { useRootStore } from '../../stores/context';
import { Btn } from '../bits';

/** How often a waiting restart asks again whether Theodore is idle. */
export const RESTART_POLL_MS = 5000;

/** A floating pill once an update is installed on disk: the running app
 *  is still the old build until it restarts. Shown over the app and over
 *  the sign-in, so a signed-out window still sees it. `install_update`
 *  restarts only while idle — no agent run, empty outbox — and otherwise
 *  does nothing; so a restart that didn't happen says why, and asks again
 *  every few seconds until it does (or the user cancels). */
export const UpdateReady = observer(function UpdateReady({
  inline = false,
}: {
  /** In the app's banner row; otherwise pinned to the window's top. */
  inline?: boolean;
}) {
  const update = useRootStore().ephemeral.readyUpdate;
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(
      () => void api.installUpdate().catch(() => {}),
      RESTART_POLL_MS,
    );
    return () => clearInterval(id);
  }, [waiting]);
  if (!update) return null;
  const restart = () =>
    void api
      .installUpdate()
      // Still here: the app was busy, so the restart waits.
      .then(() => setWaiting(true))
      .catch(() => {
        // toasted by api.ts
      });
  const pill = (
    <div
      role="status"
      className="update-ready pointer-events-auto flex items-center gap-3 rounded-full border border-separator bg-surface py-1 pe-1 ps-4 text-sm shadow-lg"
    >
      {waiting ? (
        <span className="update-waiting text-muted">
          Restarts once agent runs and pending GitHub actions finish
        </span>
      ) : (
        <span>
          Theodore <span className="font-medium">{update.version}</span> is
          installed
        </span>
      )}
      {waiting ? (
        <Btn
          tone="ghost"
          className="rounded-full"
          onPress={() => setWaiting(false)}
        >
          Cancel
        </Btn>
      ) : (
        <Btn
          tone="primary"
          icon={<ArrowRotateRight />}
          className="rounded-full"
          onPress={restart}
        >
          Restart to update
        </Btn>
      )}
    </div>
  );
  return inline ? (
    pill
  ) : (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-40 flex justify-center px-4">
      {pill}
    </div>
  );
});
