/**
 * A space waiting for usage limits to reset (docs/spaces.md "Usage
 * limits"), above the composer: when it continues, Continue now, Cancel.
 */
import { useState } from 'react';
import { Button } from '@heroui/react';
import type { Space, SpacePause } from '../../gen/contract';
import { api } from '../../core/api';
import { pauseText } from '../agentLimit';

export function SpacePaused({ space }: { space: Space }) {
  const pause = space.paused;
  if (!pause || space.status === 'archived') return null;
  // A new pause is a new row: its clock reads from when it is shown.
  return <PausedRow key={pause.since} space={space.id} pause={pause} />;
}

function PausedRow({ space, pause }: { space: string; pause: SpacePause }) {
  const [busy, setBusy] = useState<'continue' | 'cancel' | null>(null);
  const [now] = useState(() => Date.now());
  const act = (what: 'continue' | 'cancel') => {
    setBusy(what);
    const req = { space };
    void (
      what === 'continue'
        ? api.spacePauseContinue(req)
        : api.spacePauseCancel(req)
    )
      // Toasted by api.ts.
      .catch(() => {})
      .finally(() => setBusy(null));
  };
  return (
    <div className="space-paused flex items-center gap-2 px-2 text-xs text-warning">
      <span className="min-w-0 flex-1 truncate">
        {pauseText(pause.until, now)}
      </span>
      <Button
        size="sm"
        variant="tertiary"
        className="space-pause-continue h-6 shrink-0 px-2 text-xs"
        isDisabled={busy != null}
        isPending={busy === 'continue'}
        onPress={() => act('continue')}
      >
        Continue now
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="space-pause-cancel h-6 shrink-0 px-2 text-xs"
        isDisabled={busy != null}
        isPending={busy === 'cancel'}
        onPress={() => act('cancel')}
      >
        Cancel
      </Button>
    </div>
  );
}
