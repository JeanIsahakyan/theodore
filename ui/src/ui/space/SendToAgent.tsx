/** "Send to agent" (docs/spaces.md §3) next to a thread's, a draft's or a
 *  finding's own actions — only on a space's PR or its own review, and
 *  only with build mode on. The comment becomes the space's next turn. */
import { useState } from 'react';
import { PaperPlane } from '@gravity-ui/icons';
import { Button, Tooltip } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { PrId, SpaceFeedback } from '../../gen/contract';
import { api } from '../../core/api';
import { useRootStore } from '../../stores/context';
import { isBuildMode } from './mode';
import { spaceOfReview } from './spaces';

export const SendToAgent = observer(function SendToAgent({
  pr,
  item,
}: {
  pr: PrId;
  item: SpaceFeedback;
}) {
  const store = useRootStore();
  const [busy, setBusy] = useState(false);
  if (!isBuildMode(store)) return null;
  const space = spaceOfReview(store.models.spaces.all(), pr);
  if (!space) return null;
  const running = space.status === 'running';
  const send = async () => {
    setBusy(true);
    try {
      await api.spaceSendFeedback({ space: space.id, items: [item] });
      store.ephemeral.toast(`Sent to ${space.name}`, 'info', {
        label: 'Open',
        onAction: () => store.ui.go({ name: 'space', id: space.id }),
      });
    } catch {
      // toasted by api.ts
    } finally {
      setBusy(false);
    }
  };
  return (
    <Tooltip>
      <Button
        size="sm"
        variant="ghost"
        className="send-to-agent gap-1.5"
        isDisabled={running}
        isPending={busy}
        onPress={() => void send()}
      >
        <PaperPlane className="size-3.5" />
        Send to agent
      </Button>
      <Tooltip.Content>
        {running
          ? `${space.agent} is still working in ${space.name}`
          : `The next turn of ${space.name}, quoting this with its file and line`}
      </Tooltip.Content>
    </Tooltip>
  );
});
