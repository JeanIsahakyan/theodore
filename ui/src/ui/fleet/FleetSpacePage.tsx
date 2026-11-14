/** One space of the fleet (docs/fleet.md): started here on another device,
 *  or hosted here for another. Its lines, the open question, and — while
 *  it can take one — a composer; Stop while a turn runs. A space hosted
 *  here is steered from its own local page instead. */
import { useEffect, useState } from 'react';
import { Button, Chip } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { FleetRemoteSpace, FleetSpaceLine } from '../../gen/contract';
import { api } from '../../core/api';
import { useRootStore, useUi } from '../../stores/context';
import { Md } from '../../highlight';
import { ChatEmpty, ChatLog } from '../ChatTurn';
import { Composer } from '../space/Composer';
import { FleetQuestionCard } from './FleetQuestionCard';
import {
  MODE_LABEL,
  STATUS_COLOR,
  STATUS_LABEL,
  canSend,
  canStop,
  spaceTitle,
} from './fleet';

/** One line of the history, styled by what it is. */
export function FleetLine({ line }: { line: FleetSpaceLine }) {
  const common = { 'data-kind': line.kind, 'data-seq': line.seq };
  switch (line.kind) {
    case 'turn':
      return (
        <div {...common} className="fleet-line flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-default px-3.5 py-2 text-sm">
            {line.text}
          </div>
        </div>
      );
    case 'reply':
      return (
        <div {...common} className="fleet-line text-sm">
          <Md text={line.text} untrusted />
        </div>
      );
    case 'tool':
      return (
        <div
          {...common}
          className="fleet-line truncate font-mono text-xs text-muted"
          title={line.text}
        >
          {line.text}
        </div>
      );
    case 'question':
      return (
        <div
          {...common}
          className="fleet-line rounded-lg border border-warning/40 px-3 py-2 text-sm"
        >
          <span className="text-xs font-medium text-muted">Asked </span>
          {line.text}
        </div>
      );
    case 'ended':
      return (
        <div
          {...common}
          className="fleet-line flex items-center gap-3 text-xs text-muted"
        >
          <span className="h-px flex-1 bg-separator" />
          {line.text}
          <span className="h-px flex-1 bg-separator" />
        </div>
      );
    case 'gap':
      return (
        <div
          {...common}
          className="fleet-line rounded-lg border border-dashed border-separator px-3 py-1.5 text-center text-xs text-muted"
        >
          {line.text || 'Some of the history is missing'}
        </div>
      );
    case 'started':
    case 'status':
    default:
      return (
        <div {...common} className="fleet-line text-center text-xs text-muted">
          {line.text}
        </div>
      );
  }
}

function composerNote(s: FleetRemoteSpace): string {
  switch (s.status) {
    case 'running':
      return 'Running: Stop it to say something else';
    case 'starting':
      return 'Starting on the other device…';
    case 'stopped':
      return 'This space was stopped';
    case 'failed':
      return 'This space failed to start';
    default:
      return 'Say what to do next';
  }
}

export const FleetSpacePage = observer(function FleetSpacePage({
  id,
}: {
  id: string;
}) {
  const store = useRootStore();
  const ui = useUi();
  const fleet = store.fleet;
  const space = fleet.spaces.get(id);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fleet.loadLines(id);
  }, [fleet, id]);

  if (!space) {
    return (
      <div className="fleet-space flex min-w-0 flex-1 items-center justify-center text-sm text-muted">
        This space isn't in your fleet any more.
      </div>
    );
  }

  const lines = fleet.lines.get(id) ?? [];
  const question = fleet.questionOf(id);
  const origin = fleet.device(space.origin_device)?.name ?? 'another device';

  const send = () => {
    const t = text.trim();
    if (!t || busy || !canSend(space.status)) return;
    setBusy(true);
    void api
      .fleetSend({ space: id, text: t })
      .then(() => setText(''))
      .catch(() => {
        // toasted by api.ts; the text stays
      })
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="fleet-space view flex min-w-0 flex-1 flex-col"
      data-space={id}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-separator px-5 py-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">
            {spaceTitle(space)}
          </span>
          <span className="truncate text-xs text-muted">
            {space.hosted_here
              ? `Running here for ${origin}`
              : `on ${space.host_name}`}{' '}
            · {space.project_name} · {space.branch} · {MODE_LABEL[space.mode]}
          </span>
        </div>
        <Chip
          size="sm"
          variant="soft"
          color={STATUS_COLOR[space.status]}
          className="fleet-status"
        >
          {STATUS_LABEL[space.status]}
        </Chip>
        {space.hosted_here && space.local_space && (
          <Button
            size="sm"
            variant="tertiary"
            className="fleet-open-local"
            onPress={() => ui.go({ name: 'space', id: space.local_space! })}
          >
            Open space
          </Button>
        )}
      </header>
      {space.error && (
        <div
          role="alert"
          className="fleet-error border-b border-separator px-5 py-2 text-xs text-danger"
        >
          {space.error}
        </div>
      )}
      <ChatLog scope={`fleet:${id}`}>
        {lines.length === 0 ? (
          <ChatEmpty
            icon={null}
            title={spaceTitle(space)}
            hint={
              space.last_reply ??
              (space.status === 'starting'
                ? 'Waiting for the other device to start it.'
                : 'Nothing said yet.')
            }
          />
        ) : (
          lines.map((l) => <FleetLine key={l.seq} line={l} />)
        )}
        {question && (
          <FleetQuestionCard key={question.ask_id} question={question} />
        )}
      </ChatLog>
      {space.hosted_here ? (
        <div className="fleet-hosted shrink-0 border-t border-separator px-5 py-3 text-xs text-muted">
          Running here for {origin}. Steer it from its space on this computer.
        </div>
      ) : (
        <div className="mx-auto w-full max-w-[860px] shrink-0 px-4 pb-4">
          <Composer
            value={text}
            onChange={setText}
            onSubmit={send}
            placeholder={composerNote(space)}
            label="Message to the space"
            disabled={!canSend(space.status) || busy}
            running={canStop(space.status)}
            onStop={() => void api.fleetStop(id).catch(() => {})}
          />
        </div>
      )}
    </div>
  );
});
