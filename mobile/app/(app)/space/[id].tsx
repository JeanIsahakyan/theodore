/**
 * One space. A host that mirrors its rows gets the desktop's chat: your
 * messages, the agent's replies with their activity, the plan card, the live
 * turn, the question, a composer with the mode, Stop while a turn runs. A host
 * that doesn't is shown by its summary lines. Fleet text is untrusted: no link
 * opens and no image loads.
 *
 * ```text
 * mirror for this space ─▶ chatView(mirror) ─▶ turns ─ live ─ queued ─ question
 * none                  ─▶ lines (started, turn, tool, reply, …)
 * ```
 *
 * The composer rides on the keyboard (iOS and Android); focusing an answer
 * in the question card keeps the card in view; dragging the list closes the
 * keyboard.
 *
 * Controls are the native kit (docs/mobile.md "Native UI"):
 *
 * ```text
 * [ Ask | Plan | Edit ]                      Segmented
 * ( Ask the agent to change something… )    ChatField (focus() on Revise)
 * [Send]                                     Button
 * [Stop] ─▶ confirm() ─▶ stopSpace           while a turn runs
 * plan reply: [Approve] [Revise]             SpaceChat's PlanActions
 * ```
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useServices } from '../../../src/services';
import { useFleetState } from '../../../src/state/fleet';
import type { ChatMessage } from '../../../src/fleet/contract';
import { mirrored } from '../../../src/fleet/mirror';
import type { SpaceLine, SpaceView } from '../../../src/fleet/types';
import type { FleetMode } from '../../../src/gen/fleet';
import { ChatField } from '../../../src/ui/ChatField';
import type { ChatFieldHandle } from '../../../src/ui/chatFieldTypes';
import { Badge, Empty, Notice } from '../../../src/ui/kit';
import { Button, Segmented, confirm } from '../../../src/ui/native';
import { QuestionCard } from '../../../src/ui/QuestionCard';
import { bottomPad } from '../../../src/ui/keyboard';
import {
  KeyboardScreen,
  keyboardDismissMode,
  useKeyboardUp,
} from '../../../src/ui/KeyboardSafe';
import {
  LiveReply,
  MessageRow,
  ProgressCard,
  QueuedRow,
  type PlanProps,
} from '../../../src/ui/SpaceChat';
import {
  APPROVED_TEXT,
  buildMode,
  chatView,
  composerModes,
  sendMode,
  type ChatTurn,
  type ChatView,
} from '../../../src/ui/chat';
import {
  MODE_HINT,
  MODE_LABEL,
  RUN_WARNING,
  STATUS_LABEL,
  STATUS_TONE,
  canSend,
  canStop,
  errorText,
  mergeLines,
  questionFor,
  spaceTitle,
} from '../../../src/ui/logic';
import { mono, usePalette } from '../../../src/ui/theme';

const EMPTY_LINES: SpaceLine[] = [];

function Line({ line }: { line: SpaceLine }) {
  const p = usePalette();
  switch (line.kind) {
    case 'turn':
      return (
        <View style={[styles.turn, { backgroundColor: p.surfaceMuted }]}>
          <Text selectable style={[styles.body, { color: p.text }]}>
            {line.text}
          </Text>
        </View>
      );
    case 'reply':
      return (
        <Text selectable style={[styles.body, { color: p.text }]}>
          {line.text}
        </Text>
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
        <View style={[styles.asked, { borderColor: p.warning }]}>
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

/** The whole title (the bar's is cut with "…"), the status, where it runs. */
function Header({ space }: { space: SpaceView }) {
  const p = usePalette();
  return (
    <View style={styles.header}>
      <Text
        selectable
        numberOfLines={3}
        style={[styles.headerTitle, { color: p.text }]}
      >
        {spaceTitle(space)}
      </Text>
      <View style={styles.headerMeta}>
        <Badge
          label={STATUS_LABEL[space.status]}
          tone={STATUS_TONE[space.status]}
        />
        <Text
          selectable
          style={[styles.small, styles.shrink, { color: p.muted }]}
        >
          Runs on {space.hostName}
          {space.projectName ? ` · ${space.projectName}` : ''}
          {space.branch ? ` · ${space.branch}` : ''} · {MODE_LABEL[space.mode]}
        </Text>
      </View>
      {space.error ? <Notice tone="danger">{space.error}</Notice> : null}
    </View>
  );
}

/** Your message, the replies under it, the live reply while it runs. */
const TurnRow = memo(function TurnRow({
  turn,
  chat,
  live,
  plan,
}: {
  turn: ChatTurn;
  chat: ChatView;
  live: boolean;
  plan: PlanProps | null;
}) {
  return (
    <View style={styles.turnRow}>
      {turn.messages.map((m: ChatMessage) => {
        const agent = m.author.kind === 'agent';
        const undone = chat.undone.has(m.id);
        return (
          <MessageRow
            key={m.id}
            m={m}
            undone={undone}
            plan={agent && !undone && chat.plans.has(m.id)}
            tagged={chat.tagged}
            actions={agent && chat.planHere === m.id ? plan : null}
          />
        );
      })}
      {live && chat.live ? <LiveReply live={chat.live} /> : null}
    </View>
  );
});

function composerNote(
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
  const input = useRef<ChatFieldHandle>(null);
  const chatList = useRef<FlatList<ChatTurn>>(null);
  const lineList = useRef<FlatList<SpaceLine>>(null);
  const atEnd = useRef(true);
  const insets = useSafeAreaInsets();
  const keyboardUp = useKeyboardUp();

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
  // Revising lasts while there is a plan to revise.
  const revising = reviseAsked && chat?.planHere != null;

  if (!space) {
    return (
      <>
        <Stack.Screen options={{ title: 'Space' }} />
        <Empty
          title="This space isn't in your fleet any more"
          hint="It was removed, or you no longer follow it."
        />
      </>
    );
  }

  const question = chat?.question ?? questionFor(space, routed);
  // A failed turn takes the next message; a space that failed to start
  // isn't on the host.
  const hosted = !!mirror?.space;
  const sendable =
    canSend(space.status) || (space.status === 'failed' && hosted);
  const modes = composerModes(host?.maxMode ?? null);
  const picked = modes.includes(mode) ? mode : (modes.at(-1) ?? 'ask');
  const build = mirror?.space ? buildMode(mirror.space) : 'edit';

  const send = () => {
    const t = text.trim();
    if (!t || sending || !sendable) return;
    setSending(true);
    setError(null);
    atEnd.current = true;
    fleet
      .send(id, t, sendMode(picked, space.mode))
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
      atEnd.current = true;
      fleet
        .send(id, APPROVED_TEXT, build)
        .catch((e: unknown) => setError(errorText(e)))
        .finally(() => setApproving(false));
    },
    onRevise: () => {
      setMode('plan');
      setRevising(true);
      input.current?.focus();
    },
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    atEnd.current =
      contentSize.height - (contentOffset.y + layoutMeasurement.height) < 80;
  };
  const follow = () => {
    if (!atEnd.current) return;
    chatList.current?.scrollToEnd({ animated: false });
    lineList.current?.scrollToEnd({ animated: false });
  };
  // The card is the list's last row: stick to the end, so the list
  // shrinking for the keyboard keeps the field and Send answer in view.
  const answering = () => {
    atEnd.current = true;
    follow();
  };

  const footer = chat ? (
    <View style={styles.tail}>
      {chat.live && chat.turns.length === 0 ? (
        <LiveReply live={chat.live} />
      ) : null}
      {chat.queued.map((m) => (
        <QueuedRow key={m.id} m={m} />
      ))}
      {question ? (
        <QuestionCard
          key={question.askId}
          question={question}
          onFocusAnswer={answering}
        />
      ) : null}
    </View>
  ) : question ? (
    <QuestionCard
      key={question.askId}
      question={question}
      onFocusAnswer={answering}
    />
  ) : undefined;

  const empty = (
    <Text style={[styles.small, styles.center, { color: p.muted }]}>
      {space.lastReply ??
        (space.status === 'starting'
          ? 'Waiting for the other device to start it.'
          : 'Nothing said yet.')}
    </Text>
  );

  const lastTurn = chat?.turns.at(-1)?.key;

  return (
    <KeyboardScreen>
      <Stack.Screen options={{ title: spaceTitle(space) }} />
      {chat ? (
        <FlatList
          ref={chatList}
          style={styles.flex}
          data={chat.turns}
          keyExtractor={(t) => t.key}
          renderItem={({ item }) => (
            <TurnRow
              turn={item}
              chat={chat}
              live={item.key === lastTurn}
              plan={plan}
            />
          )}
          onScroll={onScroll}
          scrollEventThrottle={64}
          onContentSizeChange={follow}
          onLayout={follow}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={keyboardDismissMode}
          ListHeaderComponent={<Header space={space} />}
          ListEmptyComponent={chat.live ? undefined : empty}
          ListFooterComponent={footer}
        />
      ) : (
        <FlatList
          ref={lineList}
          style={styles.flex}
          data={lines}
          keyExtractor={(l) => String(l.seq)}
          renderItem={({ item }) => <Line line={item} />}
          onScroll={onScroll}
          scrollEventThrottle={64}
          onContentSizeChange={follow}
          onLayout={follow}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={keyboardDismissMode}
          ListHeaderComponent={<Header space={space} />}
          ListEmptyComponent={empty}
          ListFooterComponent={footer}
        />
      )}
      <View
        style={[
          styles.composer,
          {
            backgroundColor: p.surface,
            borderColor: p.border,
            paddingBottom: bottomPad(12, insets.bottom, keyboardUp),
          },
        ]}
      >
        {chat?.error ? (
          <Text
            numberOfLines={3}
            selectable
            style={[styles.small, { color: p.danger }]}
          >
            {chat.error}
          </Text>
        ) : null}
        {chat?.progress ? <ProgressCard progress={chat.progress} /> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Segmented
          label="Mode"
          choices={modes.map((m) => ({
            value: m,
            label: MODE_LABEL[m],
            accessibilityLabel: `Mode ${MODE_LABEL[m]}: ${MODE_HINT[m]}`,
          }))}
          value={picked}
          onChange={setMode}
          disabled={sending}
        />
        {picked === 'run' && space.mode !== 'run' ? (
          <Text style={[styles.small, { color: p.warning }]}>
            {RUN_WARNING}
          </Text>
        ) : null}
        <View style={styles.composerRow}>
          <ChatField
            ref={input}
            accessibilityLabel="Message to the space"
            multiline
            minLines={1}
            maxLines={6}
            disabled={!sendable || sending}
            value={text}
            onChangeText={setText}
            placeholder={composerNote(space, revising, hosted)}
            style={styles.flex}
          />
          {canStop(space.status) ? (
            <Button
              label="Stop"
              variant="destructive"
              loading={stopping}
              onPress={() => void stop()}
            />
          ) : (
            <Button
              label="Send"
              variant="primary"
              disabled={!sendable || text.trim() === ''}
              loading={sending}
              onPress={send}
            />
          )}
        </View>
      </View>
    </KeyboardScreen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 16, gap: 18 },
  turnRow: { gap: 14 },
  tail: { gap: 14 },
  header: { gap: 8 },
  headerMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: { fontSize: 22, fontWeight: '700', lineHeight: 28 },
  shrink: { flexShrink: 1 },
  body: { fontSize: 16, lineHeight: 22 },
  small: { fontSize: 13 },
  center: { textAlign: 'center' },
  tool: { fontSize: 12 },
  turn: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    borderRadius: 16,
    borderCurve: 'continuous',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  asked: {
    borderWidth: 1,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  ended: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  gap: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 10,
    paddingVertical: 6,
    alignItems: 'center',
  },
  composer: {
    gap: 8,
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
});
