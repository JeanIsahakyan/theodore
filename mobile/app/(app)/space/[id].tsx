/**
 * One space: header, its lines, the open question, a composer while it can
 * take a message, Stop while a turn runs. Plain text only: an agent's reply is
 * never rendered as links or images.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useServices } from '../../../src/services';
import { useFleetState } from '../../../src/state/fleet';
import type { SpaceLine, SpaceView } from '../../../src/fleet/types';
import {
  Badge,
  Button,
  Card,
  Confirm,
  Empty,
  Notice,
} from '../../../src/ui/kit';
import { QuestionCard } from '../../../src/ui/QuestionCard';
import {
  MODE_LABEL,
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
        <View style={[styles.turn, { backgroundColor: p.accent }]}>
          <Text selectable style={[styles.body, { color: p.onAccent }]}>
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

function Header({ space }: { space: SpaceView }) {
  const p = usePalette();
  return (
    <Card>
      <View style={styles.headerTop}>
        <Text numberOfLines={2} style={[styles.headerTitle, { color: p.text }]}>
          {spaceTitle(space)}
        </Text>
        <Badge
          label={STATUS_LABEL[space.status]}
          tone={STATUS_TONE[space.status]}
        />
      </View>
      <Text selectable style={[styles.small, { color: p.muted }]}>
        on {space.hostName} · {space.projectName} · {space.branch} ·{' '}
        {MODE_LABEL[space.mode]}
      </Text>
      {space.error ? <Notice tone="danger">{space.error}</Notice> : null}
    </Card>
  );
}

function composerNote(s: SpaceView): string {
  switch (s.status) {
    case 'running':
      return 'Running: stop it to say something else';
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

export default function SpaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { fleet } = useServices();
  const p = usePalette();
  const space = useFleetState((s) => s.spaces.find((x) => x.space === id));
  const stored = useFleetState((s) => s.lines[id] ?? EMPTY_LINES);
  const routed = useFleetState((s) => s.questions);
  const [loaded, setLoaded] = useState<SpaceLine[]>(EMPTY_LINES);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState<'ask' | 'busy' | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const question = questionFor(space, routed);
  const sendable = canSend(space.status);

  const send = () => {
    const t = text.trim();
    if (!t || sending || !sendable) return;
    setSending(true);
    setError(null);
    fleet
      .send(id, t)
      .then(() => setText(''))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setSending(false));
  };

  const stop = () => {
    setStopping('busy');
    setError(null);
    fleet
      .stopSpace(id)
      .then(() => setStopping(null))
      .catch((e: unknown) => {
        setError(errorText(e));
        setStopping(null);
      });
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ title: spaceTitle(space) }} />
      <FlatList
        style={styles.flex}
        data={lines}
        keyExtractor={(l) => String(l.seq)}
        renderItem={({ item }) => <Line line={item} />}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={<Header space={space} />}
        ListEmptyComponent={
          <Text style={[styles.small, styles.center, { color: p.muted }]}>
            {space.lastReply ??
              (space.status === 'starting'
                ? 'Waiting for the other device to start it.'
                : 'Nothing said yet.')}
          </Text>
        }
        ListFooterComponent={
          question ? (
            <QuestionCard key={question.askId} question={question} />
          ) : undefined
        }
      />
      <View
        style={[
          styles.composer,
          { backgroundColor: p.surface, borderColor: p.border },
        ]}
      >
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {stopping ? (
          <Confirm
            title="Stop this space? The agent stops after its current step."
            confirmLabel="Stop"
            danger
            busy={stopping === 'busy'}
            onConfirm={stop}
            onCancel={() => setStopping(null)}
          />
        ) : null}
        <View style={styles.composerRow}>
          <TextInput
            accessibilityLabel="Message to the space"
            multiline
            editable={sendable && !sending}
            value={text}
            onChangeText={setText}
            placeholder={composerNote(space)}
            placeholderTextColor={p.muted}
            style={[
              styles.input,
              {
                backgroundColor: p.background,
                borderColor: p.border,
                color: p.text,
              },
            ]}
          />
          {canStop(space.status) ? (
            <Button
              label="Stop"
              kind="danger"
              disabled={stopping !== null}
              onPress={() => setStopping('ask')}
            />
          ) : (
            <Button
              label="Send"
              kind="primary"
              disabled={!sendable || text.trim() === ''}
              busy={sending}
              onPress={send}
            />
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 16, gap: 12 },
  headerTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700' },
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
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
});
