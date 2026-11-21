/**
 * One space, drawn like the chat template's conversation. A host that
 * mirrors its rows gets the desktop's chat: your messages, the agent's
 * replies with their activity, Approve / Revise under a plan, the live
 * turn, the question, a composer with the mode, Stop while a turn runs. A
 * host that doesn't is shown by its summary lines. Fleet text is
 * untrusted: no link opens and no image loads.
 *
 * ```text
 * [☰]        fix the login bug…       [🔔][✎]    SpaceHeader: the main
 *            on mac-A · Running                  header, name, host · status
 * ┌ Conversation (Legend List, keyboard-aware) ─────────────────────┐
 * │  theodore · fix-login · Edit                  details, error     │
 * │  ╭ Sub-spaces: title (status) mode, nested ╮  its children        │
 * │                           ╭ your message ╮                       │
 * │  › 3 tool calls  ▤ ▸_                         grey rows, fold    │
 * │  The agent's reply, markdown                                     │
 * │  (Approve) (Revise)                           plan reply         │
 * │  Working · 12s                                live turn, shimmer │
 * │  ╭ question card ╮                            footer             │
 * │                                        ( ⌄ )  scroll to the end  │
 * │ ╭ notes (progress, run warning) ╮             Glass / card       │
 * │ ╭ Ask the agent to change something…      ╮   PromptInput in a   │
 * │ │ (Edit ⌄) (Opus 4.1 · High ⌄)        (↑) │   floating dock      │
 * └─╰───────────────────────────────────────╯───────────────────────┘
 *
 * mirror for this space ─▶ chatView(mirror) ─▶ messages ─ live ─ queued ─ question
 * none                  ─▶ lines (started, turn, tool, reply, …)
 * (↑) Send ─▶ fleet.send(mode only when not the space's own, picks)
 * (■) Stop while running ─▶ confirm() ─▶ fleet.stopSpace
 * Revise ─▶ mode Plan, the field focused; Approve ─▶ send APPROVED_TEXT in the build mode
 * ```
 *
 * The composer floats over the list on every platform (iOS 26+: Liquid
 * Glass, iOS < 26: chrome blur, Android: Material 3 surface, web: a card);
 * the list is inset by its height and rides on the keyboard with it.
 */
import { useLocalSearchParams } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, type TextInputInstance } from 'react-native';
import {
  ComposerDock,
  Conversation,
  ConversationScrollButton,
  Message,
  PromptInput,
  type ConversationHandle,
} from '../../../src/components/chat';
import { ChatMarkdown } from '../../../src/components/markdown';
import {
  ModeMenu,
  ModelChip,
} from '../../../src/components/pickers/composer-chips';
import { MainHeader } from '../../../src/components/main-header';
import { SpaceHeader } from '../../../src/components/space-header';
import type { ChatMessage } from '../../../src/fleet/contract';
import { mirrored } from '../../../src/fleet/mirror';
import type { SpaceLine, SpaceView } from '../../../src/fleet/types';
import type { FleetMode, MirroredSubSpace } from '../../../src/gen/fleet';
import { useServices } from '../../../src/services';
import { useGlassHeaderInset } from '../../../src/shell/glassHeader';
import { useFleetState } from '../../../src/state/fleet';
import { useCompose } from '../../../src/state/compose';
import { NO_PICK, sendPicks, spaceOwn } from '../../../src/ui/agents';
import {
  APPROVED_TEXT,
  buildMode,
  chatView,
  composerModes,
  sendMode,
  type ChatView,
} from '../../../src/ui/chat';
import { Empty, Notice } from '../../../src/ui/kit';
import {
  MODE_LABEL,
  RUN_WARNING,
  STATUS_LABEL,
  canSend,
  canStop,
  errorText,
  mergeLines,
  questionFor,
  spaceTitle,
} from '../../../src/ui/logic';
import { Glass, confirm } from '../../../src/ui/native';
import { QuestionCard } from '../../../src/ui/QuestionCard';
import { SubSpaces } from '../../../src/ui/SubSpaces';
import {
  LiveReply,
  MessageRow,
  ProgressCard,
  QueuedRow,
  type PlanProps,
} from '../../../src/ui/SpaceChat';
import { mono, usePalette } from '../../../src/ui/theme';

const EMPTY_LINES: SpaceLine[] = [];
/** Until the dock reports its height. */
const DOCK_GUESS = 112;

function Line({ line }: { line: SpaceLine }) {
  const p = usePalette();
  switch (line.kind) {
    case 'turn':
      return <Message from="user">{line.text}</Message>;
    case 'reply':
      return (
        <Message from="assistant">
          <ChatMarkdown>{line.text}</ChatMarkdown>
        </Message>
      );
    case 'tool':
      return (
        <Text
          selectable
          numberOfLines={2}
          style={[mono, styles.tool, { color: p.muted }]}
        >
          {line.text}
        </Text>
      );
    case 'question':
      return (
        <View
          className="rounded-2xl border px-3 py-2"
          style={[styles.continuous, { borderColor: p.warning }]}
        >
          <Text selectable style={[styles.body, { color: p.text }]}>
            <Text style={{ color: p.warning, fontWeight: '600' }}>Asked </Text>
            {line.text}
          </Text>
        </View>
      );
    case 'ended':
      return (
        <View style={styles.ended}>
          <View style={[styles.rule, { backgroundColor: p.border }]} />
          <Text style={[styles.small, { color: p.muted }]}>{line.text}</Text>
          <View style={[styles.rule, { backgroundColor: p.border }]} />
        </View>
      );
    case 'gap':
      return (
        <View style={[styles.gap, { borderColor: p.border }]}>
          <Text style={[styles.small, { color: p.muted }]}>
            {line.text || 'Some of the history is missing'}
          </Text>
        </View>
      );
    case 'started':
    case 'status':
    default:
      return (
        <Text style={[styles.small, styles.center, { color: p.muted }]}>
          {line.text}
        </Text>
      );
  }
}

/** Where it runs and how, at the top of the chat; the space's error, its
 *  sub-spaces. */
function Details({
  space,
  subs,
}: {
  space: SpaceView;
  subs: Readonly<Record<string, MirroredSubSpace>> | undefined;
}) {
  const p = usePalette();
  const where = [
    space.projectName,
    space.branch,
    MODE_LABEL[space.mode],
  ].filter(Boolean);
  return (
    <View style={styles.details}>
      <Text
        selectable
        style={[styles.small, styles.center, { color: p.muted }]}
      >
        {where.join(' · ')}
      </Text>
      {space.error ? <Notice tone="danger">{space.error}</Notice> : null}
      {subs ? <SubSpaces root={space.space} subs={subs} /> : null}
    </View>
  );
}

/** A stored message of the chat, with what the space says about it. */
const Row = memo(function Row({
  m,
  chat,
  plan,
}: {
  m: ChatMessage;
  chat: ChatView;
  plan: PlanProps | null;
}) {
  const agent = m.author.kind === 'agent';
  const undone = chat.undone.has(m.id);
  return (
    <View style={styles.row}>
      <MessageRow
        m={m}
        undone={undone}
        plan={agent && !undone && chat.plans.has(m.id)}
        tagged={chat.tagged}
        actions={agent && chat.planHere === m.id ? plan : null}
      />
    </View>
  );
});

function placeholderFor(
  s: SpaceView,
  revising: boolean,
  hosted: boolean,
): string {
  switch (s.status) {
    case 'running':
      return 'Running: stop it to say something else';
    case 'starting':
      return 'Starting on the other device…';
    case 'stopped':
      return 'This space was stopped';
    case 'failed':
      return hosted ? 'Say what to do next' : 'This space failed to start';
    default:
      return revising
        ? 'What should change in the plan?'
        : 'Ask the agent to change something…';
  }
}

const messageKey = (m: ChatMessage) => m.id;
const lineKey = (l: SpaceLine) => String(l.seq);

export default function SpaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { fleet } = useServices();
  const p = usePalette();
  const space = useFleetState((s) => s.spaces.find((x) => x.space === id));
  const stored = useFleetState((s) => s.lines[id] ?? EMPTY_LINES);
  const mirror = useFleetState((s) => s.mirrors[id]);
  const routed = useFleetState((s) => s.questions);
  const host = useFleetState((s) =>
    s.devices.find((d) => d.deviceId === space?.hostDevice),
  );
  const [loaded, setLoaded] = useState<SpaceLine[]>(EMPTY_LINES);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [approving, setApproving] = useState(false);
  const [reviseAsked, setRevising] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownMode = space?.mode ?? 'edit';
  const [mode, setMode] = useState<FleetMode>(ownMode);
  const [modeOf, setModeOf] = useState<FleetMode>(ownMode);
  // An agent, model or effort from the host's list (the model sheet,
  // src/state/compose.ts): from the next message on, kept for this space
  // until changed; nothing picked keeps the space's own.
  const agentPick = useCompose((s) => s.spacePicks[id]) ?? NO_PICK;
  const [dock, setDock] = useState(DOCK_GUESS);
  const input = useRef<TextInputInstance>(null);
  const list = useRef<ConversationHandle>(null);
  const top = useGlassHeaderInset();

  // Sticky per space: the next turn starts in the space's last mode.
  if (modeOf !== ownMode) {
    setModeOf(ownMode);
    setMode(ownMode);
  }

  useEffect(() => {
    let live = true;
    fleet
      .lines(id)
      .then((l) => live && setLoaded(l))
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [fleet, id]);

  const lines = useMemo(() => mergeLines(stored, loaded), [stored, loaded]);
  const chat = useMemo(
    () =>
      space && mirror && mirrored(mirror) ? chatView(mirror, space) : null,
    [mirror, space],
  );
  const messages = useMemo(
    () => chat?.turns.flatMap((t) => t.messages) ?? [],
    [chat],
  );
  // Revising lasts while there is a plan to revise.
  const revising = reviseAsked && chat?.planHere != null;
  const toEnd = useCallback(() => list.current?.scrollToEnd(), []);

  if (!space) {
    return (
      <View style={{ paddingTop: top }}>
        <MainHeader title="Space" />
        <Empty
          title="This space isn't in your fleet any more"
          hint="It was removed, or you no longer follow it."
        />
      </View>
    );
  }

  const question = chat?.question ?? questionFor(space, routed);
  // A failed turn takes the next message; a space that failed to start
  // isn't on the host.
  const hosted = !!mirror?.space;
  const sendable =
    canSend(space.status) || (space.status === 'failed' && hosted);
  const running = canStop(space.status);
  const modes = composerModes(host?.maxMode ?? null);
  const picked = modes.includes(mode) ? mode : (modes.at(-1) ?? 'ask');
  const build = mirror?.space ? buildMode(mirror.space) : 'edit';
  // None from a host too old to list them: no chip, nothing sent.
  const hostAgents = host?.agents ?? [];
  const ownAgent = spaceOwn(mirror?.space);
  const picks = sendPicks(hostAgents, agentPick, ownAgent);

  const send = () => {
    const t = text.trim();
    if (!t || sending || !sendable) return;
    setSending(true);
    setError(null);
    toEnd();
    fleet
      .send(id, t, sendMode(picked, space.mode), picks)
      .then(() => {
        setText('');
        setRevising(false);
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setSending(false));
  };

  const stop = async () => {
    if (stopping) return;
    const sure = await confirm({
      title: 'Stop this space?',
      message: 'The agent stops after its current step.',
      confirmLabel: 'Stop',
      destructive: true,
    });
    if (!sure) return;
    setStopping(true);
    setError(null);
    fleet
      .stopSpace(id)
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setStopping(false));
  };

  const plan: PlanProps = {
    build,
    busy: approving,
    onApprove: () => {
      setApproving(true);
      setError(null);
      toEnd();
      fleet
        .send(id, APPROVED_TEXT, build, picks)
        .catch((e: unknown) => setError(errorText(e)))
        .finally(() => setApproving(false));
    },
    onRevise: () => {
      setMode('plan');
      setRevising(true);
      input.current?.focus();
    },
  };

  const card = question ? (
    <QuestionCard
      key={question.askId}
      question={question}
      onFocusAnswer={toEnd}
    />
  ) : null;
  const footer = (
    <View style={styles.tail}>
      {chat?.live ? <LiveReply live={chat.live} waiting={!!question} /> : null}
      {chat?.queued.map((m) => (
        <QueuedRow key={m.id} m={m} />
      ))}
      {card}
    </View>
  );

  const empty =
    chat?.live || question ? null : (
      <Text style={[styles.small, styles.center, { color: p.muted }]}>
        {space.lastReply ??
          (space.status === 'starting'
            ? 'Waiting for the other device to start it.'
            : 'Nothing said yet.')}
      </Text>
    );

  const notes = [
    chat?.error ? (
      <Text
        key="chat-error"
        numberOfLines={3}
        selectable
        style={[styles.small, { color: p.danger }]}
      >
        {chat.error}
      </Text>
    ) : null,
    chat?.progress ? (
      <ProgressCard key="progress" progress={chat.progress} />
    ) : null,
    picked === 'run' && space.mode !== 'run' ? (
      <Text key="run" style={[styles.small, { color: p.warning }]}>
        {RUN_WARNING}
      </Text>
    ) : null,
  ].filter((n) => n !== null);

  const details = <Details space={space} subs={mirror?.subSpaces} />;

  const chips = (
    <>
      <ModeMenu
        modes={modes}
        value={picked}
        onChange={setMode}
        disabled={sending}
        testID="space-mode"
      />
      <ModelChip space={id} disabled={sending} />
    </>
  );

  return (
    <View className="flex-1 bg-background">
      <SpaceHeader
        title={spaceTitle(space)}
        subtitle={`on ${space.hostName} · ${STATUS_LABEL[space.status]}`}
      />
      {chat ? (
        <Conversation
          ref={list}
          data={messages}
          keyExtractor={messageKey}
          renderItem={({ item }) => (
            <Row
              m={item}
              chat={chat}
              plan={chat.planHere === item.id ? plan : null}
            />
          )}
          header={details}
          footer={footer}
          empty={empty}
          composerHeight={dock}
          topInset={top}
        >
          <ConversationScrollButton />
        </Conversation>
      ) : (
        <Conversation
          ref={list}
          data={lines}
          keyExtractor={lineKey}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Line line={item} />
            </View>
          )}
          header={details}
          footer={footer}
          empty={empty}
          composerHeight={dock}
          topInset={top}
        >
          <ConversationScrollButton />
        </Conversation>
      )}
      <ComposerDock floating onHeight={setDock}>
        {notes.length > 0 ? (
          <Glass radius={20} style={styles.notes}>
            {notes}
          </Glass>
        ) : null}
        <PromptInput
          value={text}
          onChangeText={setText}
          onSubmit={send}
          placeholder={placeholderFor(space, revising, hosted)}
          disabled={!running && !sendable}
          editable={sendable && !sending}
          sending={sending}
          running={running}
          onStop={() => void stop()}
          stopping={stopping}
          canSubmit={sendable && text.trim() !== ''}
          leading={chips}
          error={error}
          inputRef={input}
          testID="space-composer"
        />
      </ComposerDock>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingBottom: 18 },
  tail: { gap: 18, paddingBottom: 4 },
  details: { gap: 8, paddingBottom: 18, alignItems: 'center' },
  continuous: { borderCurve: 'continuous' },
  body: { fontSize: 16, lineHeight: 22 },
  small: { fontSize: 13 },
  center: { textAlign: 'center' },
  tool: { fontSize: 12 },
  ended: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  gap: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 10,
    paddingVertical: 6,
    alignItems: 'center',
  },
  notes: { gap: 8, padding: 12, marginBottom: 8 },
});
