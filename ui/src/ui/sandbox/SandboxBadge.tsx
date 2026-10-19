import { Tooltip } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { useRootStore } from '../../stores/context';
import { sandboxBadge } from './sandbox';

/** A loud amber pill so a sandbox window can't pass for the real app.
 *  Renders nothing outside sandbox mode. */
export const SandboxBadge = observer(function SandboxBadge() {
  const store = useRootStore();
  const badge = sandboxBadge(store.ephemeral.sandbox);
  if (!badge) return null;
  return (
    <Tooltip>
      <Tooltip.Trigger
        aria-label={badge.tooltip}
        className="sandbox-badge shrink-0 cursor-default rounded-full bg-warning px-2 py-0.5 text-[10px] font-bold tracking-wider text-warning-foreground"
      >
        {badge.label}
      </Tooltip.Trigger>
      <Tooltip.Content>{badge.tooltip}</Tooltip.Content>
    </Tooltip>
  );
});
