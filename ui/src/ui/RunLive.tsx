import { useEffect, type ReactNode, type RefObject } from 'react';
import { observer } from 'mobx-react-lite';
import { useRootStore } from '../stores/context';
import { Md } from '../highlight';

/** A run's text as it streams in. Its own observer: a piece arriving
 *  re-renders this, not the chat around it. `follow` is scrolled into view
 *  as the text grows. */
export const LiveText = observer(function LiveText({
  run,
  fallback = null,
  follow,
}: {
  run: string;
  /** Shown until the first piece arrives. */
  fallback?: ReactNode;
  follow?: RefObject<HTMLElement | null>;
}) {
  const store = useRootStore();
  const text = store.ephemeral.agentText.get(run);
  useEffect(() => {
    if (text) follow?.current?.scrollIntoView?.({ block: 'end' });
  }, [text, follow]);
  if (!text) return <>{fallback}</>;
  return (
    <div className="live-text text-sm leading-relaxed">
      <Md text={text} />
    </div>
  );
});
