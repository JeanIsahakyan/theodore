/**
 * Android: the activity sheet in Compose, inside the strip's
 * `ModalBottomSheet` (`sheet-host.android.tsx`); the same sections as
 * `ActivitySheet.tsx`: the plan, this turn's subagents, the sub-spaces.
 */
import { Column, HorizontalDivider, Row, Text } from '@expo/ui/jetpack-compose';
import {
  fillMaxWidth,
  padding,
  semantics,
  verticalScroll,
  weight,
} from '@expo/ui/jetpack-compose/modifiers';
import {
  SheetHeading,
  SheetRow,
  SheetTitle,
} from '../components/pickers/sheet-parts.android';
import { openSubSpace } from '../shell/navigate';
import {
  SHEET_SUB_LABEL,
  activityBusy,
  progressLabel,
  subagentLabel,
} from './activity';
import { MODE_LABEL } from './logic';
import type { SubSpaceState } from './subSpaceTree';
import { usePalette } from './theme';
import { useActivityView, useAgentTimes, useNow } from './useActivity';

type MarkKind = 'running' | 'done' | 'pending' | 'failed' | 'waiting';

const GLYPH: Record<MarkKind, string> = {
  running: '◌',
  done: '✓',
  pending: '○',
  failed: '✕',
  waiting: '?',
};

const SUB_MARK: Record<SubSpaceState, MarkKind> = {
  running: 'running',
  waiting: 'waiting',
  done: 'done',
  merged: 'done',
  failed: 'failed',
};

function ReadRow({
  mark,
  label,
  value,
  dim,
}: {
  mark: MarkKind;
  label: string;
  value?: string | null;
  dim?: boolean;
}) {
  const p = usePalette();
  const color =
    mark === 'done'
      ? p.success
      : mark === 'failed'
        ? p.danger
        : mark === 'waiting'
          ? p.warning
          : mark === 'running'
            ? p.accent
            : p.muted;
  return (
    <Row
      verticalAlignment="center"
      horizontalArrangement={{ spacedBy: 12 }}
      modifiers={[
        fillMaxWidth(),
        padding(24, 8, 24, 8),
        semantics({ contentDescription: value ? `${label}, ${value}` : label }),
      ]}
    >
      <Text color={color} style={{ typography: 'bodyMedium' }}>
        {GLYPH[mark]}
      </Text>
      <Text
        color={dim ? p.muted : p.text}
        maxLines={1}
        style={{ typography: 'bodyLarge' }}
        modifiers={[weight(1)]}
      >
        {label}
      </Text>
      {value ? (
        <Text color={p.muted} maxLines={1} style={{ typography: 'bodySmall' }}>
          {value}
        </Text>
      ) : null}
    </Row>
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
    setTimeout(() => openSubSpace(space, child), 50);
  };
  const empty = !view.progress && !view.agents.length && !view.subs.length;
  return (
    <Column
      modifiers={[fillMaxWidth(), verticalScroll(), padding(0, 0, 0, 24)]}
    >
      <SheetTitle>Activity</SheetTitle>
      {empty ? (
        <Text color={p.muted} modifiers={[padding(24, 8, 24, 8)]}>
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
          {view.progress ? (
            <HorizontalDivider modifiers={[padding(24, 8, 24, 8)]} />
          ) : null}
          <SheetHeading>{view.turnTitle}</SheetHeading>
          {view.agents.map((a) => (
            <ReadRow
              key={a.call}
              mark={a.status}
              label={a.description}
              value={subagentLabel(a, times, now)}
            />
          ))}
        </>
      ) : null}
      {view.subs.length ? (
        <>
          {view.progress || view.agents.length ? (
            <HorizontalDivider modifiers={[padding(24, 8, 24, 8)]} />
          ) : null}
          <SheetHeading>Sub-spaces</SheetHeading>
          {view.subs.map((r) => {
            const title = r.sub.title || r.sub.space;
            const state = SHEET_SUB_LABEL[r.state];
            return (
              <SheetRow
                key={r.sub.space}
                label={`${GLYPH[SUB_MARK[r.state]]}  ${title}`}
                detail={`${state} · ${MODE_LABEL[r.sub.mode]}`}
                chevron
                accessibilityLabel={`${title}, ${state}, opens the sub-space`}
                onPress={() => open(r.sub.space)}
              />
            );
          })}
        </>
      ) : null}
    </Column>
  );
}
