import { ArrowRotateRight } from '@gravity-ui/icons';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { api } from '../../core/api';
import type { Space } from '../../gen/contract';
import { useRootStore } from '../../stores/context';
import { Btn } from '../bits';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How often a waiting restart asks again whether Theodore is idle. */
export const RESTART_POLL_MS = 5000;

/** Agents at work on this computer: what a restart pauses and resumes
 *  (docs/spaces.md §7 "Restart with turns running"). */
export function runningAgents(spaces: readonly Space[]): number {
  return spaces.filter((s) => !s.remote && s.status === 'running').length;
}

/** "3 agents will pause and resume after the update"; `null` with none. */
export function pauseWarning(running: number): string | null {
  if (running === 0) return null;
  return `${plural(running, 'agent')} will pause and resume after the update`;
}

/** The waiting pill's line: pausing agents, or a host write still queued. */
export function waitingText(running: number): string {
  return running > 0
    ? `Pausing ${plural(running, 'agent')}… they resume after the update`
    : 'Restarts once pending GitHub actions finish';
}

/** A floating pill once an update is installed on disk: the running app
 *  is still the old build until it restarts. Shown over the app and over
 *  the sign-in, so a signed-out window still sees it. `install_update`
 *  pauses the running agents (they resume after the restart) and
 *  restarts; a host write still queued holds it off, so the pill says
 *  why and asks again every few seconds until it goes (or the user
 *  cancels). With agents running it says so before the click. */
export const UpdateReady = observer(function UpdateReady({
  inline = false,
}: {
  /** In the app's banner row; otherwise pinned to the window's top. */
  inline?: boolean;
}) {
  const store = useRootStore();
  const update = store.ephemeral.readyUpdate;
  const running = runningAgents(store.models.spaces.all());
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
        <span className="update-waiting text-muted">{waitingText(running)}</span>
      ) : (
        <span className="flex flex-col leading-tight">
          <span>
            Theodore <span className="font-medium">{update.version}</span> is
            installed
          </span>
          {pauseWarning(running) && (
            <span className="update-pause-warning text-xs text-muted">
              {pauseWarning(running)}
            </span>
          )}
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
