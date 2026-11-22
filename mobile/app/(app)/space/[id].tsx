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
 *            on mac-A · Running · Edit           header, name, host · status · mode
 * ┌ Conversation (Legend List, keyboard-aware) ─────────────────────┐
 * │  theodore · fix-login · Edit                  details, error     │
 * │  ╭ Sub-spaces: title (status) mode, nested ╮  its children        │
 * │                           ╭ your message ╮                       │
 * │  › 3 tool calls  ▤ ▸_                         grey rows, fold    │
 * │  The agent's reply, markdown                                     │
 * │  (Approve) (Revise)                           plan reply         │
 * │  Working · 12s                                live turn, shimmer │
 * │                      Sending…  ╭ and the tests ╮  your send, at once│
 * │  ╭ question card ╮                            footer             │
 * │                                        ( ⌄ )  scroll to the end  │
 * │ ╭ ⟳ 2 of 5 · Edit auth · 1 queued   1m 12s ╮  ActivityStrip on   │
 * │ │ ◌ 2 agents · 2 sub-spaces (1 waiting) ⌃  │  the notes panel    │
 * │ ╰ run warning, chat error ─────────────────╯  (Glass / card)     │
 * │ ╭ Ask the agent to change something…      ╮   PromptInput in a   │
 * │ │ (Opus 4.1 · High ⌄)                 (↑) │   floating dock      │
 * └─╰───────────────────────────────────────╯───────────────────────┘
 *
 * mirror for this space ─▶ chatView(mirror) ─▶ messages ─ live ─ queued ─ pending ─ question
 * none                  ─▶ lines (started, turn, tool, reply, …) ─ pending ─ question
 * the next message's mode ─▶ the model sheet's Mode step (compose store,
 *     spaceModes: sticky per space, the next turn starts in the space's last mode)
 * (↑) Send ─▶ the field cleared, your bubble "Sending…" at once (src/state/pending.ts)
 *     ─▶ fleet.send(mode only when not the space's own, picks)
 *     ok {message}          ─▶ kept until the host's row (by id, else text + time)
 *                              arrives; no rows mirrored ─▶ until a "Turn n" line
 *     ok {queued, position} ─▶ "Queued" until the mirrored queued row replaces it;
 *                              "· 1 queued" on the strip's first line meanwhile
 *     refused / silent      ─▶ "Not sent · why" with Retry and Edit (text back)
 * (■) Stop while running, beside Send ─▶ confirm() ─▶ fleet.stopSpace
 * running ─▶ the strip's first line: the plan's active step, else the newest
 *     live step, else (not mirrored) the newest log line, and a timer;
 *     waiting on a question ─▶ "Waiting for your answer ↓" scrolls to the card
 * subagents / sub-spaces ─▶ the strip's second line ─▶ the activity sheet
 *     (src/ui/ActivitySheet) ─▶ a sub-space row ─▶ /sub-space/[space]/[child]
 * Revise ─▶ mode Plan, the field focused; Approve ─▶ APPROVED_TEXT as your
 *     bubble at once, sent in the build mode (the same rules as a send)
 * /space/pending_… (a start from Home, the host not answered yet)
 *     ─▶ the goal as your bubble, "Starting on mac-A…"; the host's ok ─▶ the
 *        route replaced with the real space's; refused ─▶ Home, the goal back
 * ```
 *
 * The composer floats over the list on every platform (iOS 26+: Liquid
 * Glass, iOS < 26: chrome blur, Android: Material 3 surface, web: a card);
 * the list is inset by its height and rides on the keyboard with it.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, type TextInputInstance } from 'react-native';
import {
  AttachButton,
  AttachmentStrip,
  ComposerDock,
  Conversation,
  ConversationScrollButton,
  Message,
  PromptInput,
  SentFiles,
  Shimmer,
  useAttach,
  type ConversationHandle,
} from '../../../src/components/chat';
import { FileLinkProvider } from '../../../src/components/chat/file-link';
import { ChatMarkdown } from '../../../src/components/markdown';
import { ModelChip } from '../../../src/components/pickers/composer-chips';
import { useSpaceMode } from '../../../src/components/pickers/use-picker';
import { MainHeader } from '../../../src/components/main-header';
import { SpaceHeader } from '../../../src/components/space-header';
import type { ChatMessage, TurnStep } from '../../../src/fleet/contract';
import { mirrored } from '../../../src/fleet/mirror';
import type {
  AgentPicks,
  SpaceLine,
  SpaceView,
} from '../../../src/fleet/types';
import type {
  BlobRef,
  FleetMode,
  MirroredSubSpace,
} from '../../../src/gen/fleet';
import { useServices } from '../../../src/services';
import { useGlassHeaderInset } from '../../../src/shell/glassHeader';
import { backHome, spaceHref } from '../../../src/shell/navigate';
import { useFleetState } from '../../../src/state/fleet';
import { setSpaceMode, useCompose } from '../../../src/state/compose';
import {
  addSend,
  dropSend,
  dropSends,
  restoreHome,
  selectSends,
  sendFailed,
  sendRetried,
  sendSettled,
  usePending,
} from '../../../src/state/pending';
import { log, track } from '../../../src/telemetry/log';
import { NO_PICK, sendPicks, spaceOwn } from '../../../src/ui/agents';
import { canSendWith } from '../../../src/ui/attachments';
import {
  APPROVED_TEXT,
  buildMode,
  chatView,
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
  refusalCode,
  spaceTitle,
} from '../../../src/ui/logic';
import {
  approving,
  isPendingId,
  queuedCount,
  rowOfMessage,
  sentMs,
  startTitle,
  startingLabel,
  unmatched,
  unmatchedByLines,
} from '../../../src/ui/pending';
import { ActivityStrip, useActivityStrip } from '../../../src/ui/ActivityStrip';
import { Glass, confirm } from '../../../src/ui/native';
import { QuestionCard } from '../../../src/ui/QuestionCard';
import { SubSpaces } from '../../../src/ui/SubSpaces';
import {
  LiveReply,
  MessageRow,
  PendingRow,
  QueuedRow,
  type PlanProps,
} from '../../../src/ui/SpaceChat';
import { mono, usePalette } from '../../../src/ui/theme';

const EMPTY_LINES: SpaceLine[] = [];
const EMPTY_STEPS: TurnStep[] = [];
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
      return 'Add to the queue…';
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
const nothing = () => null;

export default function SpaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return isPendingId(id) ? (
    <StartingScreen id={id} />
  ) : (
    <LiveSpaceScreen id={id} />
  );
}

/**
 * A space started from Home, before the host answered: its goal as your
 * first bubble, "Starting on mac-A…". The host's ok names the space: the
 * route becomes its own. Refused: back on Home, the goal in the field.
 */
function StartingScreen({ id }: { id: string }) {
  const p = usePalette();
  const top = useGlassHeaderInset();
  const start = usePending((s) => s.starts[id]);
  const [dock, setDock] = useState(DOCK_GUESS);
  const moved = useRef(false);

  useEffect(() => {
    if (!start || moved.current) return;
    if (start.space) {
      moved.current = true;
      router.replace(spaceHref(start.space));
    } else if (start.state === 'failed') {
      moved.current = true;
      restoreHome(start.goal, start.error ?? 'The space was not started.');
      backHome();
    }
  }, [start]);

  if (!start) {
    return (
      <View style={{ paddingTop: top }}>
        <MainHeader title="Space" />
        <Empty
          title="This space isn't here any more"
          hint="It was started, or it was not."
        />
      </View>
    );
  }
  const where = [start.projectName, MODE_LABEL[start.mode]].filter(Boolean);
  const footer = (
    <View style={styles.tail}>
      <View style={[styles.userRow, styles.userGap]}>
        {start.files?.length ? <SentFiles files={start.files} /> : null}
        <Message from="user">{start.goal}</Message>
      </View>
      <Message
        from="assistant"
        accessibilityLabel={startingLabel(start.hostName)}
      >
        <View style={styles.status}>
          <Shimmer>{startingLabel(start.hostName)}</Shimmer>
        </View>
      </Message>
    </View>
  );
  return (
    <View className="flex-1 bg-background">
      <SpaceHeader
        title={startTitle(start.goal)}
        subtitle={`on ${start.hostName} · ${STATUS_LABEL.starting} · ${MODE_LABEL[start.mode]}`}
      />
      <Conversation
        data={EMPTY_LINES}
        keyExtractor={lineKey}
        renderItem={nothing}
        header={
          <View style={styles.details}>
            <Text style={[styles.small, styles.center, { color: p.muted }]}>
              {where.join(' · ')}
            </Text>
          </View>
        }
        footer={footer}
        composerHeight={dock}
        topInset={top}
      />
      <ComposerDock floating onHeight={setDock}>
        <PromptInput
          value=""
          onChangeText={() => {}}
          onSubmit={() => {}}
          placeholder="Starting on the other device…"
          disabled
          testID="space-composer"
        />
      </ComposerDock>
    </View>
  );
}

function LiveSpaceScreen({ id }: { id: string }) {
  const { fleet } = useServices();
  const p = usePalette();
  const space = useFleetState((s) => s.spaces.find((x) => x.space === id));
  const stored = useFleetState((s) => s.lines[id] ?? EMPTY_LINES);
  const mirror = useFleetState((s) => s.mirrors[id]);
  const routed = useFleetState((s) => s.questions);
  const host = useFleetState((s) =>
    s.devices.find((d) => d.deviceId === space?.hostDevice),
  );
  // Your messages the host hasn't shown yet (src/state/pending.ts).
  const pending = usePending(selectSends(id));
  const [loaded, setLoaded] = useState<SpaceLine[]>(EMPTY_LINES);
  const [text, setText] = useState('');
  const [reviseAsked, setRevising] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The next message's mode (the model sheet's Mode step, Revise): sticky
  // per space, the space's own once a turn ran in another one.
  const picked = useSpaceMode(id)?.picked ?? 'edit';
  // An agent, model or effort from the host's list (the model sheet,
  // src/state/compose.ts): from the next message on, kept for this space
  // until changed; nothing picked keeps the space's own.
  const agentPick = useCompose((s) => s.spacePicks[id]) ?? NO_PICK;
  const [dock, setDock] = useState(DOCK_GUESS);
  const input = useRef<TextInputInstance>(null);
  const list = useRef<ConversationHandle>(null);
  const top = useGlassHeaderInset();
  // Files for the space's .context/, sealed for its host and uploaded on
  // pick (docs/mobile.md "Files").
  const attach = useAttach(id, space?.hostDevice ?? null);
  const fileTarget = useMemo(
    () =>
      space
        ? {
            space: id,
            hostDevice: space.hostDevice,
            hostName: space.hostName,
            spaceName: spaceTitle(space),
          }
        : null,
    [id, space],
  );

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
  // The optimistic bubbles the host hasn't shown yet: a mirrored row (by
  // id, else text and time) or, without rows, a "Turn n" line stands for
  // one and drops it.
  const shown = useMemo(() => {
    if (!pending.length) return pending;
    if (chat) {
      const rows = [...messages, ...chat.queued].map(rowOfMessage);
      return unmatched(pending, rows);
    }
    return unmatchedByLines(pending, lines);
  }, [pending, chat, messages, lines]);
  useEffect(() => {
    if (shown.length === pending.length) return;
    dropSends(
      id,
      pending.filter((x) => !shown.includes(x)).map((x) => x.key),
    );
  }, [id, pending, shown]);

  // Revising lasts while there is a plan to revise.
  const revising = reviseAsked && chat?.planHere != null;
  const toEnd = useCallback(() => list.current?.scrollToEnd(), []);
  const routedHere = routed.some((q) => q.space === id);
  const running = space ? canStop(space.status) : false;
  // The strip above the composer: what the space is doing (src/ui/activity.ts).
  const stripProps = {
    space: id,
    status: space?.status ?? ('idle' as const),
    question: !!(chat?.question ?? space?.question) || routedHere,
    progress: chat?.progress ?? null,
    liveSteps: chat?.live?.steps ?? EMPTY_STEPS,
    lastLog: chat ? null : (lines.at(-1)?.text ?? null),
    queued: (chat ? chat.queued.length : 0) + queuedCount(shown, running),
  };
  const activity = useActivityStrip(stripProps);

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
  // While a turn runs the host queues what you send (docs/fleet.md
  // "Sends queue"); Stop stays beside Send.
  const sendable =
    canSend(space.status) || running || (space.status === 'failed' && hosted);
  const build = mirror?.space ? buildMode(mirror.space) : 'edit';
  // None from a host too old to list them: no chip, nothing sent.
  const hostAgents = host?.agents ?? [];
  const ownAgent = spaceOwn(mirror?.space);
  const picks = sendPicks(hostAgents, agentPick, ownAgent);

  /** The request behind a bubble: its answer settles or fails the bubble. */
  const dispatch = (
    key: string,
    t: string,
    mode: FleetMode | null,
    with_: AgentPicks,
    attachments: BlobRef[] = [],
    kind: 'send' | 'approve' = 'send',
  ) => {
    const row = () => pending.find((x) => x.key === key);
    fleet
      .send(id, t, mode, with_, attachments)
      .then((r) => {
        track('message_sent', {
          surface: 'space',
          kind,
          queued: r.queued,
          ms: sentMs(row()),
          retries: row()?.retries ?? 0,
          outcome: 'ok',
          code: null,
        });
        sendSettled(id, key, r);
      })
      .catch((e: unknown) => {
        const code = refusalCode(e);
        track('message_sent', {
          surface: 'space',
          kind,
          queued: false,
          ms: sentMs(row()),
          retries: row()?.retries ?? 0,
          outcome: 'failed',
          code,
        });
        log.warn('send failed', {
          op_id: key,
          space: id,
          'error.code': code ?? 'fleet.send_failed',
        });
        sendFailed(id, key, errorText(e));
      });
  };

  // Send waits for every attached file to be in the cloud.
  const canSubmit = sendable && canSendWith(text, attach.list);

  const send = () => {
    const t = text.trim();
    if (!t || !canSubmit) return;
    const { refs, files } = attach.take();
    setText('');
    setRevising(false);
    setError(null);
    const mode = sendMode(picked, space.mode);
    const key = addSend({
      space: id,
      text: t,
      at: Date.now(),
      mode,
      picks,
      afterSeq: lines.at(-1)?.seq ?? 0,
      files,
      attachments: refs,
    });
    toEnd();
    dispatch(key, t, mode, picks, refs);
  };

  const retry = (key: string) => {
    const again = sendRetried(id, key);
    if (again)
      dispatch(key, again.text, again.mode, again.picks, again.attachments);
  };

  const edit = (key: string) => {
    const back = pending.find((x) => x.key === key);
    dropSend(id, key);
    if (back && back.kind === 'send') {
      setText(back.text);
      input.current?.focus();
    }
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
      .then(() => track('space_stopped', { outcome: 'ok', code: null }))
      .catch((e: unknown) => {
        track('space_stopped', { outcome: 'failed', code: refusalCode(e) });
        setError(errorText(e));
      })
      .finally(() => setStopping(false));
  };

  const plan: PlanProps = {
    build,
    busy: approving(shown),
    onApprove: () => {
      setError(null);
      const key = addSend({
        space: id,
        text: APPROVED_TEXT,
        kind: 'approve',
        at: Date.now(),
        mode: build,
        picks,
        afterSeq: lines.at(-1)?.seq ?? 0,
      });
      toEnd();
      track('plan_decided', { decision: 'approve' });
      dispatch(key, APPROVED_TEXT, build, picks, 'approve');
    },
    onRevise: () => {
      track('plan_decided', { decision: 'revise' });
      setSpaceMode(id, 'plan');
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
      {shown.map((x) => (
        <PendingRow
          key={x.key}
          p={x}
          onRetry={() => retry(x.key)}
          onEdit={() => edit(x.key)}
        />
      ))}
      {card}
    </View>
  );

  const empty =
    chat?.live || question || shown.length ? null : (
      <Text style={[styles.small, styles.center, { color: p.muted }]}>
        {space.lastReply ??
          (space.status === 'starting'
            ? 'Waiting for the other device to start it.'
            : 'Nothing said yet.')}
      </Text>
    );

  const notes = [
    activity.shown ? (
      <ActivityStrip
        key="activity"
        {...stripProps}
        since={chat?.live?.since ?? null}
        onWaiting={toEnd}
      />
    ) : null,
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
    picked === 'run' && space.mode !== 'run' ? (
      <Text key="run" style={[styles.small, { color: p.warning }]}>
        {RUN_WARNING}
      </Text>
    ) : null,
  ].filter((n) => n !== null);

  const details = <Details space={space} subs={mirror?.subSpaces} />;

  const chips = (
    <>
      <AttachButton
        onPick={(s) => void attach.pick(s)}
        disabled={!sendable}
        busy={attach.picking}
        testID="space-attach"
      />
      <ModelChip space={id} />
    </>
  );

  return (
    <FileLinkProvider target={fileTarget}>
      <View className="flex-1 bg-background">
        <SpaceHeader
          title={spaceTitle(space)}
          subtitle={`on ${space.hostName} · ${STATUS_LABEL[space.status]} · ${MODE_LABEL[picked]}`}
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
            editable={sendable}
            running={running}
            onStop={() => void stop()}
            stopping={stopping}
            queue={running}
            canSubmit={canSubmit}
            above={
              <AttachmentStrip
                list={attach.list}
                notice={attach.notice}
                onRetry={attach.retry}
                onRemove={attach.remove}
              />
            }
            leading={chips}
            error={error}
            inputRef={input}
            testID="space-composer"
          />
        </ComposerDock>
      </View>
    </FileLinkProvider>
  );
}

const styles = StyleSheet.create({
  row: { paddingBottom: 18 },
  tail: { gap: 18, paddingBottom: 4 },
  userRow: { alignItems: 'flex-end' },
  userGap: { gap: 6 },
  status: { flexDirection: 'row', alignItems: 'center', minHeight: 22 },
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
