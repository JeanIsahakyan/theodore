import { ArrowRotateRight } from '@gravity-ui/icons';
import { observer } from 'mobx-react-lite';
import { api } from '../../core/api';
import { useRootStore } from '../../stores/context';
import { Btn } from '../bits';

/** A floating pill once an update is installed on disk: the running app
 *  is still the old build until it restarts. Shown over the app and over
 *  the sign-in, so a signed-out window still sees it. The restart waits
 *  until no agent runs and the outbox is empty (`install_update`). */
export const UpdateReady = observer(function UpdateReady({
  inline = false,
}: {
  /** In the app's banner row; otherwise pinned to the window's top. */
  inline?: boolean;
}) {
  const update = useRootStore().ephemeral.readyUpdate;
  if (!update) return null;
  const pill = (
    <div className="update-ready pointer-events-auto flex items-center gap-3 rounded-full border border-separator bg-surface py-1 pe-1 ps-4 text-sm shadow-lg">
      <span>
        Theodore <span className="font-medium">{update.version}</span> is
        installed
      </span>
      <Btn
        tone="primary"
        icon={<ArrowRotateRight />}
        className="rounded-full"
        onPress={() => void api.installUpdate()}
      >
        Restart to update
      </Btn>
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
