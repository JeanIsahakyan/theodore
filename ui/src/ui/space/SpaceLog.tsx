/**
 * A space's chat above the composer: nothing said yet is a plain page, the
 * rest is one row per turn in a `VirtualChat`.
 */
import { memo, useCallback, type ReactNode } from 'react';
import { Pencil } from '@gravity-ui/icons';
import { observer } from 'mobx-react-lite';
import type { ChatMessage, Space, SpaceConfigView } from '../../gen/contract';
import { useRootStore } from '../../stores/context';
import { ChatEmpty, ChatLive, ChatLog } from '../ChatTurn';
import {
  chatRows,
  estimateRowHeight,
  pairTurns,
  type ChatRow,
} from './chatTurns';
import { runsByReply, setupView } from './commands';
import { SpaceSetupAssistHint } from './ConfigSection';
import { QueuedMessages } from './QueuedMessages';
import { splitQueue } from './queue';
import { SetupNote, SetupStage } from './SpaceCommands';
import { SpaceMessage } from './SpaceMessage';
import { QuestionCard } from './SpacePlan';
import { spaceChatKey } from './spaces';
import { VirtualChat } from './VirtualChat';

const isPinned = (row: ChatRow) => row.kind === 'head' || row.kind === 'tail';

export const SpaceLog = observer(function SpaceLog({
  space,
  config,
  onRevise,
}: {
  space: Space;
  config: SpaceConfigView | null;
  onRevise: () => void;
}) {
  const store = useRootStore();
  // Queued messages wait under the running turn, in the order they send.
  const { sent, queued } = splitQueue([
    ...store.models.chatMessages.byPr(spaceChatKey(space.id)),
  ]);
  const turns = pairTurns(sent);
  const run = space.status === 'running' ? space.run : null;
  // A turn whose check still runs has its reply stored already: its steps
  // and text show there, the check under them.
  const replied =
    run != null &&
    [...runsByReply(space.id, space.turn_log).values()].includes(run);
  const live = run != null && !replied;
  const setup = setupView(space);
  const asking = run != null && space.question?.run === run;
  const head = (
    <>
      <SetupStage space={space} />
      <SetupNote space={space} />
    </>
  );
  const tail = (
    <>
      <QueuedMessages space={space} queued={queued} />
      {asking && space.question && (
        <QuestionCard
          key={space.question.id}
          space={space}
          question={space.question}
        />
      )}
    </>
  );

  const renderRow = useRowRenderer(space.id, onRevise, head, tail);
  if (turns.length === 0 && !run) {
    return (
      <ChatLog scope={space.id}>
        {head}
        {setup !== 'stage' && (
          <>
            <ChatEmpty
              icon={<Pencil />}
              title="Tell the agent what to change"
              hint="It works in its own worktree; your checkout is never touched."
            />
            <SpaceSetupAssistHint space={space} config={config} />
          </>
        )}
        {tail}
      </ChatLog>
    );
  }
  const rows = chatRows(turns, {
    head: setup != null,
    live,
    tail: queued.length > 0 || asking,
  });
  return (
    <VirtualChat
      scope={space.id}
      items={rows}
      estimate={estimateRowHeight}
      isPinned={isPinned}
      renderItem={renderRow}
    />
  );
});

function useRowRenderer(
  spaceId: string,
  onRevise: () => void,
  head: ReactNode,
  tail: ReactNode,
) {
  return useCallback(
    (row: ChatRow) => {
      switch (row.kind) {
        case 'head':
          return head;
        case 'tail':
          return tail;
        case 'live':
          return <SpaceLive spaceId={spaceId} />;
        case 'turn':
          return (
            <TurnRow
              spaceId={spaceId}
              messages={row.messages}
              live={row.live}
              onRevise={onRevise}
            />
          );
      }
    },
    [spaceId, onRevise, head, tail],
  );
}

/** Your message, the reply and its cards, the live reply while it runs. The
 *  turn's messages keep their identity until one of them changes. */
const TurnRow = memo(
  function TurnRow({
    spaceId,
    messages,
    live,
    onRevise,
  }: {
    spaceId: string;
    messages: ChatMessage[];
    live: boolean;
    onRevise: () => void;
  }) {
    return (
      <>
        {messages.map((m) => (
          <SpaceMessage
            key={m.id}
            spaceId={spaceId}
            m={m}
            onRevise={onRevise}
          />
        ))}
        {live && <SpaceLive spaceId={spaceId} />}
      </>
    );
  },
  (a, b) =>
    a.spaceId === b.spaceId &&
    a.live === b.live &&
    a.onRevise === b.onRevise &&
    a.messages.length === b.messages.length &&
    a.messages.every((m, i) => m === b.messages[i]),
);

const SpaceLive = observer(function SpaceLive({
  spaceId,
}: {
  spaceId: string;
}) {
  const space = useRootStore().models.spaces.get(spaceId);
  const run = space?.status === 'running' ? space.run : null;
  if (!space || !run) return null;
  return <ChatLive run={run} agent={space.agent} timeline />;
});
