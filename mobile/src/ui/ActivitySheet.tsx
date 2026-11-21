/**
 * The activity sheet (iOS formSheet route, the web modal; Android draws it
 * in Compose, `ActivitySheet.android.tsx`): what the space has going, from
 * the strip's second line (docs/mobile.md "Activity strip").
 *
 * ```text
 *   Plan · 2 of 5
 *     ✓ Read the flow
 *     ⟳ Edit auth
 *     ○ Tests
 *   This turn
 *     ◌ Explore the auth flow       running · 32s
 *     ✓ Review the tests            done · 1m 4s
 *   Sub-spaces
 *     ? Fix the flaky test          waiting for an answer  ›   ─▶ its screen
 *     ⟳ Update the docs             running                ›
 *     ✓ Split the crate             merged                 ›
 * ```
 *
 * No Stop per subagent: the protocol has none. The rules are `activity.ts`.
 */
import { StyleSheet, Text, View } from 'react-native';
import {
  SheetDivider,
  SheetHeading,
  SheetRow,
  SheetTitle,
} from '../components/pickers/sheet-rows';
import { openSubSpace } from '../shell/navigate';
import {
  SHEET_SUB_LABEL,
  activityBusy,
  progressLabel,
  subagentLabel,
  type SubagentView,
} from './activity';
import { MODE_LABEL } from './logic';
import { Spinner } from './Spinner';
import type { SubSpaceRow, SubSpaceState } from './subSpaceTree';
import { usePalette } from './theme';
import { useActivityView, useAgentTimes, useNow } from './useActivity';

/** The glyph before a row: a spinner while it runs. */
function Mark({
  kind,
}: {
  kind: 'running' | 'done' | 'pending' | 'failed' | 'waiting';
}) {
  const p = usePalette();
  if (kind === 'running') {
    return (
      <View style={styles.mark}>
        <Spinner color={p.accent} />
      </View>
    );
  }
  const glyph =
    kind === 'done'
      ? '✓'
      : kind === 'failed'
        ? '✕'
        : kind === 'waiting'
          ? '?'
          : '○';
  const color =
    kind === 'done'
      ? p.success
      : kind === 'failed'
        ? p.danger
        : kind === 'waiting'
          ? p.warning
          : p.muted;
  return (
    <View style={styles.mark}>
      <Text style={[styles.glyph, { color }]}>{glyph}</Text>
    </View>
  );
}

const SUB_MARK: Record<SubSpaceState, Parameters<typeof Mark>[0]['kind']> = {
  running: 'running',
  waiting: 'waiting',
  done: 'done',
  merged: 'done',
  failed: 'failed',
};

/** A row that only reads: the plan's steps, a subagent. */
function ReadRow({
  mark,
  label,
  value,
  dim,
}: {
  mark: Parameters<typeof Mark>[0]['kind'];
  label: string;
  value?: string | null;
  dim?: boolean;
}) {
  const p = usePalette();
  return (
    <View
      accessible
      accessibilityLabel={value ? `${label}, ${value}` : label}
      style={styles.row}
    >
      <Mark kind={mark} />
      <Text
        numberOfLines={1}
        style={[
          styles.label,
          { color: dim ? p.muted : p.text },
          mark === 'done' && dim ? styles.struck : null,
        ]}
      >
        {label}
      </Text>
      {value ? (
        <Text numberOfLines={1} style={[styles.value, { color: p.muted }]}>
          {value}
        </Text>
      ) : null}
    </View>
  );
}

function AgentRow({ agent, label }: { agent: SubagentView; label: string }) {
  return (
    <ReadRow mark={agent.status} label={agent.description} value={label} />
  );
}

function SubRow({ row, onPress }: { row: SubSpaceRow; onPress: () => void }) {
  const title = row.sub.title || row.sub.space;
  const state = SHEET_SUB_LABEL[row.state];
  return (
    <View style={styles.subRow}>
      <View style={styles.subMark}>
        <Mark kind={SUB_MARK[row.state]} />
      </View>
      <View style={styles.subBody}>
        <SheetRow
          label={title}
          detail={`${state} · ${MODE_LABEL[row.sub.mode]}`}
          chevron
          accessibilityLabel={`${title}, ${state}, opens the sub-space`}
          onPress={onPress}
        />
      </View>
    </View>
  );
}

export function ActivitySheet({
  space,
  onClose,
}: {
  space: string;
  onClose: () => void;
}) {
  const p = usePalette();
  const view = useActivityView(space);
  const now = useNow(activityBusy(view.agents, view.subs));
  const times = useAgentTimes(space, view, now);
  const open = (child: string) => {
    onClose();
    // After the sheet has gone: a push from under a form sheet lands.
    setTimeout(() => openSubSpace(space, child), 50);
  };
  const empty = !view.progress && !view.agents.length && !view.subs.length;
  return (
    <View style={styles.sheet}>
      <SheetTitle>Activity</SheetTitle>
      {empty ? (
        <Text style={[styles.note, { color: p.muted }]}>
          Nothing is running in this space.
        </Text>
      ) : null}
      {view.progress ? (
        <>
          <SheetHeading>{`Plan · ${progressLabel(view.progress).split(' · ')[0]}`}</SheetHeading>
          {view.progress.steps.map((s, i) => (
            <ReadRow
              key={i}
              mark={
                s.state === 'active'
                  ? 'running'
                  : s.state === 'done'
                    ? 'done'
                    : 'pending'
              }
              label={s.label}
              dim={s.state !== 'active'}
            />
          ))}
        </>
      ) : null}
      {view.agents.length ? (
        <>
          {view.progress ? <SheetDivider /> : null}
          <SheetHeading>{view.turnTitle}</SheetHeading>
          {view.agents.map((a) => (
            <AgentRow
              key={a.call}
              agent={a}
              label={subagentLabel(a, times, now)}
            />
          ))}
        </>
      ) : null}
      {view.subs.length ? (
        <>
          {view.progress || view.agents.length ? <SheetDivider /> : null}
          <SheetHeading>Sub-spaces</SheetHeading>
          {view.subs.map((r) => (
            <SubRow
              key={r.sub.space}
              row={r}
              onPress={() => open(r.sub.space)}
            />
          ))}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingBottom: 24 },
  note: { fontSize: 15, paddingHorizontal: 20, paddingVertical: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 40,
    paddingHorizontal: 20,
  },
  mark: { width: 20, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 14, fontWeight: '600' },
  label: { flex: 1, fontSize: 15 },
  struck: { textDecorationLine: 'line-through', opacity: 0.7 },
  value: { fontSize: 13 },
  subRow: { flexDirection: 'row', alignItems: 'center' },
  subMark: { paddingLeft: 20 },
  subBody: { flex: 1, marginLeft: -8 },
});
