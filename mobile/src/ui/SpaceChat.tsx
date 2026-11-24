/**
 * A mirrored space's chat, the desktop's `SpaceLog` / `ChatMessage` drawn
 * the chat template's way (`components/chat`): your messages as bubbles on
 * the right, the agent's replies full width (its steps as compact grey rows,
 * then its markdown), Approve / Revise as pills under a plan, the live turn
 * with a shimmering status, queued messages. The rules are `chat.ts`.
 *
 * ```text
 *                               ╭ fix the login bug ╮
 *                               ╰───────────────────╯
 * › 4 tool calls, 2 messages  ▤ ▸_
 * The login now checks the token's expiry…          markdown
 * (Approve) (Revise)  Approve implements it in Edit  plan reply
 * 1m 12s · 3:37 PM   [auth.ts +12 −3]
 * ```
 *
 * A long press on a reply or on your bubble: Copy, Select text (the sheet;
 * `components/chat/long-press.tsx`).
 */
import { memo, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LongPressMenu, Message, SentFiles, Shimmer } from '../components/chat';
import { AttachmentChips } from '../components/chat/file-link';
import { ChatMarkdown } from '../components/markdown';
import type { ChatMessage, SpaceProgress } from '../fleet/contract';
import { Button } from './native';
import { Spinner } from './Spinner';
import { TimelineRows } from './Timeline';
import {
  STOPPED,
  clock,
  fromTasksLabel,
  progressLine,
  type LiveTurn,
} from './chat';
import { MODE_LABEL } from './logic';
import type { MenuAction } from './messageMenu';
import { pendingLabel, type PendingSend } from './pending';
import {
  QUEUED_ACTIONS,
  QUEUED_HINT,
  REMOVE,
  SEND_NOW,
  queuedLabel,
} from './queued';
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

function UserBubble({
  m,
  queued,
  undone,
  extras,
  onExtra,
}: {
  m: ChatMessage;
  queued?: boolean;
  undone?: boolean;
  /** The row's own long-press actions (a queued one's Send now / Remove). */
  extras?: readonly MenuAction[];
  onExtra?: (id: string) => void;
}) {
  const p = usePalette();
  const label = queued ? queuedLabel(m) : null;
  return (
    <View
      style={[styles.userRow, (queued || undone) && styles.dim]}
      accessibilityLabel={queued ? `${label} message` : 'Your message'}
      accessibilityHint={queued ? QUEUED_HINT : undefined}
    >
      {label ? (
        <Text style={[styles.small, { color: p.muted }]}>{label}</Text>
      ) : null}
      {m.attachments?.length ? (
        <AttachmentChips attachments={m.attachments} />
      ) : null}
      {m.text || !m.attachments?.length ? (
        <LongPressMenu
          text={m.text}
          kind="mine"
          extras={extras}
          onExtra={onExtra}
        >
          <Message from="user">{m.text}</Message>
        </LongPressMenu>
      ) : null}
    </View>
  );
}

// A queued bubble's words and actions: `src/ui/queued.ts`.

/** What Copy and Select text take of a reply: its text, else the words its
 *  steps hold (a reply whose text is in its steps). */
export function replyText(m: ChatMessage): string {
  if (m.text.trim()) return m.text;
  return (m.activity ?? [])
    .filter((s) => s.kind === 'text' && !s.parent)
    .map((s) => (s.kind === 'text' ? s.text : ''))
    .filter((t) => t.trim())
    .join('\n\n');
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
      <Button
        label="Approve"
        variant="primary"
        pill
        loading={busy}
        onPress={onApprove}
      />
      <Button
        label="Revise"
        variant="secondary"
        pill
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
    <LongPressMenu text={replyText(m)} kind="reply">
      <Message from="assistant" dim={marks.undone}>
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
          <ChatMarkdown>{m.text}</ChatMarkdown>
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
          <ChatMarkdown>{m.text}</ChatMarkdown>
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
      </Message>
    </LongPressMenu>
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
  if (m.author.kind === 'me') return <UserBubble m={m} undone={undone} />;
  return (
    <AgentReply m={m} marks={{ undone, plan }} tagged={tagged} plan={actions} />
  );
});

/**
 * A message of yours waiting in the host's queue (docs/spaces.md §8):
 * "Queued" while it waits its turn, "Held" when it waits for a Send. A long
 * press offers Send now (runs it now, or back in line while a turn runs)
 * and Remove, both the host's (`queued_message`).
 */
export function QueuedRow({
  m,
  onSendNow,
  onRemove,
}: {
  m: ChatMessage;
  onSendNow?: () => void;
  onRemove?: () => void;
}) {
  const extras = onSendNow && onRemove ? QUEUED_ACTIONS : undefined;
  const onExtra = (id: string) => {
    if (id === SEND_NOW.id) onSendNow?.();
    else if (id === REMOVE.id) onRemove?.();
  };
  return <UserBubble m={m} queued extras={extras} onExtra={onExtra} />;
}

/**
 * A message of yours the host hasn't shown yet (`src/ui/pending.ts`): the
 * bubble at once, "Sending…" over it, then "Queued" when the host queued
 * it; not sent ─▶ "Not sent · <why>" with Retry and Edit under it.
 *
 * ```text
 *                              Sending…
 *                    ╭ and fix the tests ╮
 *
 *            Not sent · the other device didn't answer in time
 *                    ╭ and fix the tests ╮
 *                           (Retry) (Edit)
 * ```
 */
export function PendingRow({
  p,
  onRetry,
  onEdit,
}: {
  p: PendingSend;
  onRetry: () => void;
  onEdit: () => void;
}) {
  const palette = usePalette();
  const failed = p.state === 'failed';
  const label = pendingLabel(p);
  return (
    <View
      style={[styles.userRow, !failed && styles.dim]}
      accessibilityLabel={failed ? 'Message not sent' : `${label} message`}
    >
      <Text
        numberOfLines={2}
        style={[
          styles.small,
          styles.end,
          { color: failed ? palette.danger : palette.muted },
        ]}
      >
        {failed && p.error ? `${label} · ${p.error}` : label}
      </Text>
      {p.files.length ? <SentFiles files={p.files} /> : null}
      <Message from="user">{p.text}</Message>
      {failed ? (
        <View style={styles.planActions}>
          <Button label="Retry" variant="secondary" pill onPress={onRetry} />
          <Button label="Edit" variant="plain" pill onPress={onEdit} />
        </View>
      ) : null}
    </View>
  );
}

/** Elapsed time under a running turn, in its shimmering status line. */
function LiveTimer({ since }: { since: number | null }) {
  const [start] = useState(() => since ?? Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const from = since ?? start;
  const s = Math.max(0, Math.floor((now - from) / 1000));
  return (
    <Shimmer>{`Working · ${s < 60 ? `${s}s` : formatDuration(s * 1000)}`}</Shimmer>
  );
}

/** The reply still being written: its steps as they come (the newest text
 *  with a cursor), "Working · 12s" shimmering under them — or, while the
 *  agent waits on a question, nothing ticking: the card below is the ask.
 *  Stop is the composer's. */
export function LiveReply({
  live,
  waiting = false,
}: {
  live: LiveTurn;
  waiting?: boolean;
}) {
  return (
    <Message
      from="assistant"
      accessibilityLabel={
        waiting
          ? 'The agent is waiting for your answer'
          : 'The agent is working'
      }
    >
      {live.steps.length ? (
        <TimelineRows steps={live.steps} running={!waiting} keptAs={live.run} />
      ) : null}
      {waiting ? null : (
        <View style={styles.status}>
          <LiveTimer since={live.since} />
        </View>
      )}
    </Message>
  );
}

/** A running turn on a host that doesn't mirror its rows: the newest
 *  line of its log (what it does now) over "Working · 12s". */
export function WorkingLine({ last }: { last: string | null }) {
  const p = usePalette();
  return (
    <Message from="assistant" accessibilityLabel="The agent is working">
      <View style={styles.working}>
        <Spinner color={p.accent} />
        {last ? (
          <Text
            numberOfLines={2}
            style={[styles.workingText, { color: p.text }]}
          >
            {last}
          </Text>
        ) : null}
      </View>
      <View style={styles.status}>
        <LiveTimer since={null} />
      </View>
    </Message>
  );
}

/** The agent's progress for the running turn, above the composer. */
export function ProgressCard({ progress }: { progress: SpaceProgress }) {
  const p = usePalette();
  return (
    <View
      accessibilityLabel="Agent progress"
      className="rounded-2xl bg-card"
      style={[styles.progress, { borderColor: p.border }]}
    >
      <Text style={[styles.small, { color: p.muted }]}>
        {progressLine(progress)}
      </Text>
      {progress.steps.map((s, i) => (
        <View key={i} style={styles.progressRow}>
          <View style={styles.mark}>
            {s.state === 'active' ? (
              <Spinner color={p.accent} />
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
  working: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  workingText: { flexShrink: 1, fontSize: 14 },
  small: { fontSize: 12 },
  shrink: { flexShrink: 1 },
  dim: { opacity: 0.5 },
  userRow: { alignItems: 'flex-end', gap: 6 },
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
    borderRadius: 14,
    borderCurve: 'continuous',
    paddingHorizontal: 12,
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
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 22,
  },
  progress: {
    borderWidth: StyleSheet.hairlineWidth,
    borderCurve: 'continuous',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 3,
  },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mark: { width: 16, alignItems: 'center' },
});
