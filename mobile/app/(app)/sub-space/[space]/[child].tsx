/**
 * A sub-space of a followed space, read from its host by its local id
 * (docs/mobile.md "Sub-spaces"). It isn't followed here: nothing is
 * mirrored, so the screen polls `read_space` every 3 s while it is in
 * front, and keeps what it last loaded when the host can't be reached.
 *
 * ```text
 * [‹]      Fix the flaky test                        PushedHeader (Back)
 *          sub-space of Retry on 429 · on mac-A · Waiting for you
 *  ... its last messages (read_space, up to 50) ...
 *  ⟳ Running: Edit tests/flaky.rs              32s   its running text
 *  ╭ ? Which fixture should it use? ─────────╮       its question ─▶ answer_space
 *  │ (fixtures/a)  (fixtures/b)  [Reply…]    │
 *  ╰─────────────────────────────────────────╯
 *                     Sending…  ╭ and the tests ╮  your send, at once
 * ╭──────────────────────────────────────────────╮
 * │ Message this sub-space…                 (↑) │  ─▶ send_to (its own mode: no chips)
 * ╰──────────────────────────────────────────────╯
 *
 * focused ─▶ readSpace now, then every 3 s ─▶ the host's signed, shape-checked
 *   answer ─▶ drawn        refused / offline ─▶ one line, the last read stays
 * blurred ─▶ the polling stops
 * send ─▶ the field cleared, your bubble "Sending…" (src/state/pending.ts)
 *   ─▶ ok ─▶ "Queued" while it runs, else kept until a read message of yours
 *      with that text (close in time) stands for it; refused ─▶ Retry / Edit
 * ```
 */
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, type TextInputInstance } from 'react-native';
import {
  ComposerDock,
  Conversation,
  ConversationScrollButton,
  Message,
  PromptInput,
  type ConversationHandle,
} from '../../../../src/components/chat';
import { ChatMarkdown } from '../../../../src/components/markdown';
import type {
  SubSpaceMessage,
  SubSpaceRead,
} from '../../../../src/fleet/types';
import { useServices } from '../../../../src/services';
import { useGlassHeaderInset } from '../../../../src/shell/glassHeader';
import { useFleetState } from '../../../../src/state/fleet';
import {
  addSend,
  dropSend,
  dropSends,
  selectSends,
  sendFailed,
  sendRetried,
  sendSettled,
  usePending,
} from '../../../../src/state/pending';
import { Empty, Notice } from '../../../../src/ui/kit';
import { errorText, spaceTitle } from '../../../../src/ui/logic';
import { Glass } from '../../../../src/ui/native';
import { rowOfSubSpaceMessage, unmatched } from '../../../../src/ui/pending';
import { QuestionCard } from '../../../../src/ui/QuestionCard';
import { PendingRow } from '../../../../src/ui/SpaceChat';
import { Spinner } from '../../../../src/ui/Spinner';
import {
  messageFrom,
  messageKey,
  messageSide,
  readErrorText,
  subSpaceQuestion,
  subSpaceSendable,
  subSpaceSubtitle,
} from '../../../../src/ui/subSpaceScreen';
import { usePalette } from '../../../../src/ui/theme';
import { formatDuration } from '../../../../src/ui/turnRows';
import { useNow } from '../../../../src/ui/useActivity';

/** How often the host is read while the screen is in front. */
export const SUB_SPACE_POLL_MS = 3000;
const DOCK_GUESS = 72;

function Row({ m }: { m: SubSpaceMessage }) {
  const p = usePalette();
  const side = messageSide(m);
  const from = messageFrom(m);
  return (
    <View style={styles.row}>
      {from ? (
        <Text style={[styles.small, styles.end, { color: p.muted }]}>
          {from}
        </Text>
      ) : null}
      {side === 'user' ? (
        <Message from="user">{m.text}</Message>
      ) : (
        <Message from="assistant">
          <ChatMarkdown>{m.text}</ChatMarkdown>
        </Message>
      )}
      {m.truncated ? (
        <Text style={[styles.small, { color: p.muted }]}>
          Cut: the whole message is on the computer.
        </Text>
      ) : null}
    </View>
  );
}

/** Its running turn's text so far, with a timer since this screen saw it run. */
function Running({ text }: { text: string | null }) {
  const p = usePalette();
  const now = useNow(true);
  const [since] = useState(now);
  const s = Math.floor((now - since) / 1000);
  return (
    <Message from="assistant" accessibilityLabel="The sub-space is working">
      <View style={styles.running}>
        <Spinner color={p.accent} />
        <Text numberOfLines={3} style={[styles.runningText, { color: p.text }]}>
          {text ? `Running: ${text}` : 'Running'}
        </Text>
        <Text style={[styles.small, { color: p.muted }]}>
          {s < 60 ? `${s}s` : formatDuration(s * 1000)}
        </Text>
      </View>
    </Message>
  );
}

export default function SubSpaceScreen() {
  const { space: parent, child } = useLocalSearchParams<{
    space: string;
    child: string;
  }>();
  const { fleet } = useServices();
  const p = usePalette();
  const host = useFleetState((s) => s.spaces.find((x) => x.space === parent));
  const mirrored = useFleetState((s) => s.mirrors[parent]?.subSpaces[child]);
  const [read, setRead] = useState<SubSpaceRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [dock, setDock] = useState(DOCK_GUESS);
  const list = useRef<ConversationHandle>(null);
  const input = useRef<TextInputInstance>(null);
  const top = useGlassHeaderInset();
  const hostDevice = host?.hostDevice ?? null;
  const hostName = host?.hostName ?? 'its computer';
  // Your messages the host hasn't shown yet, under the child's id
  // (src/state/pending.ts); a read message of yours with the same text,
  // close in time, stands for one.
  const pending = usePending(selectSends(child));
  const shown = useMemo(
    () =>
      pending.length && read
        ? unmatched(pending, read.messages.map(rowOfSubSpaceMessage))
        : pending,
    [pending, read],
  );
  useEffect(() => {
    if (shown.length === pending.length) return;
    dropSends(
      child,
      pending.filter((x) => !shown.includes(x)).map((x) => x.key),
    );
  }, [child, pending, shown]);

  // Read now and every 3 s while in front; a read under way isn't doubled.
  const busy = useRef(false);
  const poll = useCallback(async () => {
    if (!hostDevice || busy.current) return;
    busy.current = true;
    try {
      const r = await fleet.readSpace(hostDevice, child);
      setRead(r);
      setError(null);
    } catch (e: unknown) {
      setError(readErrorText(hostName, errorText(e)));
    } finally {
      busy.current = false;
    }
  }, [fleet, hostDevice, hostName, child]);
  useFocusEffect(
    useCallback(() => {
      void poll();
      const timer = setInterval(() => void poll(), SUB_SPACE_POLL_MS);
      return () => clearInterval(timer);
    }, [poll]),
  );
  const status = read?.status ?? mirrored?.status ?? 'unknown';

  const title = read?.title || mirrored?.title || child;
  const toEnd = useCallback(() => list.current?.scrollToEnd(), []);

  if (!host) {
    return (
      <View style={{ paddingTop: top }}>
        <Stack.Screen options={{ title: 'Sub-space' }} />
        <Empty
          title="This sub-space's space isn't in your fleet any more"
          hint="It was removed, or you no longer follow it."
        />
      </View>
    );
  }

  const sendable = subSpaceSendable(status);
  /** The request behind a bubble: its answer settles or fails the bubble. */
  const dispatch = (key: string, t: string) => {
    if (!hostDevice) return;
    fleet
      .sendTo(hostDevice, child, t)
      .then((r) => {
        sendSettled(child, key, r);
        void poll();
      })
      .catch((e: unknown) => sendFailed(child, key, errorText(e)));
  };
  const send = () => {
    const t = text.trim();
    if (!t || !sendable || !hostDevice) return;
    setText('');
    const key = addSend({ space: child, text: t, at: Date.now() });
    toEnd();
    dispatch(key, t);
  };
  const retry = (key: string) => {
    const again = sendRetried(child, key);
    if (again) dispatch(key, again.text);
  };
  const edit = (key: string) => {
    const back = pending.find((x) => x.key === key);
    dropSend(child, key);
    if (back) {
      setText(back.text);
      input.current?.focus();
    }
  };

  const question = read ? subSpaceQuestion(read) : null;
  const header = (
    <View style={styles.details}>
      <Text
        selectable
        style={[styles.small, styles.center, { color: p.muted }]}
      >
        {subSpaceSubtitle({
          parentTitle: spaceTitle(host),
          hostName,
          status,
          done: read?.done ?? mirrored?.done ?? false,
        })}
      </Text>
      {read?.goal ? (
        <Text selectable style={[styles.goal, { color: p.text }]}>
          {read.goal}
        </Text>
      ) : null}
      {read?.error ? <Notice tone="danger">{read.error}</Notice> : null}
    </View>
  );
  const footer = (
    <View style={styles.tail}>
      {status === 'running' ? <Running text={read?.live ?? null} /> : null}
      {shown.map((x) => (
        <PendingRow
          key={x.key}
          p={x}
          onRetry={() => retry(x.key)}
          onEdit={() => edit(x.key)}
        />
      ))}
      {question && hostDevice ? (
        <QuestionCard
          key={question.askId}
          question={question}
          from={`${hostName} · ${title}`}
          answer={(answers) =>
            fleet
              .answerSpace(hostDevice, child, question.askId, answers)
              .then(() => void poll())
          }
          onFocusAnswer={toEnd}
        />
      ) : null}
    </View>
  );
  const empty = shown.length ? null : read ? (
    <Text style={[styles.small, styles.center, { color: p.muted }]}>
      Nothing said yet.
    </Text>
  ) : error ? null : (
    <View style={styles.loading}>
      <Spinner color={p.muted} />
    </View>
  );
  const notes = [
    error ? (
      <Text
        key="error"
        numberOfLines={3}
        selectable
        style={[styles.small, { color: p.danger }]}
      >
        {error}
      </Text>
    ) : null,
  ].filter((n) => n !== null);

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ title }} />
      <Conversation
        ref={list}
        data={read?.messages ?? []}
        keyExtractor={(m) => messageKey(m, read?.messages.indexOf(m) ?? 0)}
        renderItem={({ item }) => <Row m={item} />}
        header={header}
        footer={footer}
        empty={empty}
        composerHeight={dock}
        topInset={top}
      >
        <ConversationScrollButton />
      </Conversation>
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
          placeholder={
            status === 'running'
              ? 'Add to its queue…'
              : 'Message this sub-space…'
          }
          disabled={!sendable || !hostDevice}
          editable={sendable}
          canSubmit={sendable && text.trim() !== ''}
          inputRef={input}
          testID="sub-space-composer"
        />
      </ComposerDock>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingBottom: 18, gap: 4 },
  tail: { gap: 18, paddingBottom: 4 },
  details: { gap: 8, paddingBottom: 18, alignItems: 'center' },
  goal: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  small: { fontSize: 13 },
  center: { textAlign: 'center' },
  end: { textAlign: 'right' },
  running: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  runningText: { flexShrink: 1, flex: 1, fontSize: 14 },
  loading: { paddingVertical: 24, alignItems: 'center' },
  notes: { gap: 8, padding: 12, marginBottom: 8 },
});
