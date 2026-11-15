/**
 * A mirrored space's chat, the desktop's `SpaceLog` / `ChatMessage` in React
 * Native: your messages as bubbles on the right, the agent's replies with
 * their activity and markdown, the plan card's Approve / Revise, the live
 * turn, queued messages and the question. The rules are `chat.ts`.
 */
import { memo, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { ChatMessage, SpaceProgress } from '../fleet/contract';
import { Button } from './kit';
import { Markdown } from './Markdown';
import { TimelineRows } from './Timeline';
import {
  STOPPED,
  clock,
  fromTasksLabel,
  progressLine,
  type LiveTurn,
} from './chat';
import { MODE_LABEL } from './logic';
import { mono, usePalette } from './theme';
import { fileChips, formatDuration } from './turnRows';
import type { FleetMode } from '../gen/fleet';

/** What the space says about one message: everything that changes its row. */
export interface MessageMarks {
  undone: boolean;
  plan: boolean;
}

export interface PlanProps {
  build: FleetMode;
  busy: boolean;
  onApprove: () => void;
  onRevise: () => void;
}

function UserBubble({ m, queued }: { m: ChatMessage; queued?: boolean }) {
  const p = usePalette();
  return (
    <View
      style={[styles.userRow, queued && styles.dim]}
      accessibilityLabel={queued ? 'Queued message' : 'Your message'}
    >
      {queued ? (
        <Text style={[styles.small, { color: p.muted }]}>Queued</Text>
      ) : null}
      {m.attachments?.length ? (
        <View style={[styles.chips, styles.end]}>
          {m.attachments.map((a) => (
            <Text
              key={a.id || a.name}
              numberOfLines={1}
              style={[
                styles.fileChip,
                { borderColor: p.border, color: p.muted },
              ]}
            >
              {a.name}
            </Text>
          ))}
        </View>
      ) : null}
      {m.text || !m.attachments?.length ? (
        <View style={[styles.bubble, { backgroundColor: p.surfaceMuted }]}>
          <Text selectable style={[styles.body, { color: p.text }]}>
            {m.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function Tag({ label, tone }: { label: string; tone: 'accent' | 'muted' }) {
  const p = usePalette();
  return (
    <Text
      style={[
        styles.tag,
        {
          backgroundColor: p.surfaceMuted,
          color: tone === 'accent' ? p.accent : p.muted,
        },
      ]}
    >
      {label}
    </Text>
  );
}

export function PlanActions({ build, busy, onApprove, onRevise }: PlanProps) {
  const p = usePalette();
  return (
    <View style={styles.planActions}>
      <Button label="Approve" kind="primary" busy={busy} onPress={onApprove} />
      <Button
        label="Revise"
        kind="secondary"
        disabled={busy}
        onPress={onRevise}
      />
      <Text style={[styles.small, styles.shrink, { color: p.muted }]}>
        Approve implements it in {MODE_LABEL[build]}
      </Text>
    </View>
  );
}

function Files({ m }: { m: ChatMessage }) {
  const p = usePalette();
  const { shown, rest } = fileChips(m.changed_files ?? []);
  return (
    <View style={styles.chips}>
      {shown.map((f) => (
        <Text
          key={f.path}
          numberOfLines={1}
          style={[styles.fileChip, { borderColor: p.border, color: p.muted }]}
        >
          {f.path.split('/').pop()}{' '}
          <Text style={[mono, { color: p.success }]}>+{f.additions}</Text>{' '}
          <Text style={[mono, { color: p.danger }]}>−{f.deletions}</Text>
        </Text>
      ))}
      {rest ? (
        <Text
          style={[styles.fileChip, { borderColor: p.border, color: p.muted }]}
        >
          +{rest.files} more{' '}
          <Text style={[mono, { color: p.success }]}>+{rest.additions}</Text>{' '}
          <Text style={[mono, { color: p.danger }]}>−{rest.deletions}</Text>
        </Text>
      ) : null}
    </View>
  );
}

function AgentReply({
  m,
  marks,
  tagged,
  plan,
}: {
  m: ChatMessage;
  marks: MessageMarks;
  tagged: boolean;
  /** Set on the reply Approve / Revise sit under. */
  plan: PlanProps | null;
}) {
  const p = usePalette();
  const agent = m.author.kind === 'agent' ? m.author.agent : '';
  const badges = (tagged && agent) || marks.plan || marks.undone;
  return (
    <View style={[styles.agent, marks.undone && styles.dim]}>
      {badges ? (
        <View style={styles.badges}>
          {tagged && agent ? <Tag label={agent} tone="muted" /> : null}
          {marks.plan ? <Tag label="plan" tone="accent" /> : null}
          {marks.undone ? <Tag label="undone" tone="muted" /> : null}
        </View>
      ) : null}
      {m.from_tasks?.length ? (
        <Text numberOfLines={1} style={[styles.small, { color: p.muted }]}>
          {fromTasksLabel(m.from_tasks)}
        </Text>
      ) : null}
      {m.activity?.length ? (
        <TimelineRows
          steps={m.activity}
          keptAs={m.id}
          pinLastText={!!m.text_in_steps || !m.text.trim()}
          keepText={!!m.failed}
        />
      ) : null}
      {m.failed && m.text && !m.text_in_steps ? (
        <Markdown text={m.text} />
      ) : null}
      {m.failed === STOPPED ? (
        <Text style={[styles.small, { color: p.muted }]}>Stopped</Text>
      ) : m.failed ? (
        <View
          accessibilityRole="alert"
          style={[styles.failed, { borderColor: p.danger }]}
        >
          <Text selectable style={[styles.small, { color: p.danger }]}>
            {m.failed}
          </Text>
        </View>
      ) : !m.text_in_steps && m.text ? (
        <Markdown text={m.text} />
      ) : null}
      {plan ? <PlanActions {...plan} /> : null}
      {m.duration_ms != null || m.changed_files?.length ? (
        <View style={styles.footer}>
          {m.duration_ms != null ? (
            <Text style={[styles.small, { color: p.muted }]}>
              {formatDuration(m.duration_ms)} · {clock(m.at)}
            </Text>
          ) : null}
          {m.changed_files?.length ? <Files m={m} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/** One stored message; re-renders only when it or its marks change. */
export const MessageRow = memo(function MessageRow({
  m,
  undone,
  plan,
  tagged,
  actions,
}: {
  m: ChatMessage;
  undone: boolean;
  /** A plan turn's reply. */
  plan: boolean;
  tagged: boolean;
  /** Approve / Revise, on the reply they act on. */
  actions: PlanProps | null;
}) {
  if (m.author.kind === 'me') {
    return (
      <View style={undone && styles.dim}>
        <UserBubble m={m} />
      </View>
    );
  }
  return (
    <AgentReply m={m} marks={{ undone, plan }} tagged={tagged} plan={actions} />
  );
});

export function QueuedRow({ m }: { m: ChatMessage }) {
  return <UserBubble m={m} queued />;
}

/** Elapsed time under a running turn. */
function LiveTimer({ since }: { since: number | null }) {
  const p = usePalette();
  const [start] = useState(() => since ?? Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const from = since ?? start;
  const s = Math.max(0, Math.floor((now - from) / 1000));
  return (
    <Text style={[mono, styles.small, { color: p.muted }]}>
      {s < 60 ? `${s}s` : formatDuration(s * 1000)}
    </Text>
  );
}

/** The reply still being written: its steps as they come, a spinner, the
 *  time so far. Stop is the composer's. */
export function LiveReply({ live }: { live: LiveTurn }) {
  const p = usePalette();
  return (
    <View style={styles.agent} accessibilityLabel="The agent is working">
      {live.steps.length ? (
        <TimelineRows steps={live.steps} running keptAs={live.run} />
      ) : null}
      <View style={styles.status}>
        <ActivityIndicator size="small" color={p.accent} />
        <LiveTimer since={live.since} />
      </View>
    </View>
  );
}

/** The agent's progress for the running turn, above the composer. */
export function ProgressCard({ progress }: { progress: SpaceProgress }) {
  const p = usePalette();
  return (
    <View
      accessibilityLabel="Agent progress"
      style={[styles.progress, { borderColor: p.border }]}
    >
      <Text style={[styles.small, { color: p.muted }]}>
        {progressLine(progress)}
      </Text>
      {progress.steps.map((s, i) => (
        <View key={i} style={styles.progressRow}>
          <View style={styles.mark}>
            {s.state === 'active' ? (
              <ActivityIndicator size="small" color={p.accent} />
            ) : (
              <Text
                style={[
                  styles.small,
                  { color: s.state === 'done' ? p.success : p.muted },
                ]}
              >
                {s.state === 'done' ? '✓' : '○'}
              </Text>
            )}
          </View>
          <Text
            numberOfLines={1}
            style={[
              styles.small,
              styles.shrink,
              {
                color: s.state === 'pending' ? p.muted : p.text,
                textDecorationLine:
                  s.state === 'done' ? 'line-through' : 'none',
                opacity: s.state === 'done' ? 0.7 : 1,
              },
            ]}
          >
            {s.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 15, lineHeight: 21 },
  small: { fontSize: 12 },
  shrink: { flexShrink: 1 },
  dim: { opacity: 0.5 },
  userRow: { alignItems: 'flex-end', gap: 6 },
  bubble: {
    maxWidth: '85%',
    borderRadius: 20,
    borderCurve: 'continuous',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  agent: { gap: 8, minWidth: 0 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: {
    fontSize: 11,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  failed: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  planActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  end: { justifyContent: 'flex-end' },
  fileChip: {
    fontSize: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    maxWidth: 220,
  },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 22 },
  progress: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 3,
  },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mark: { width: 16, alignItems: 'center' },
});
