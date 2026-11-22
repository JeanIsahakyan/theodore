/**
 * The strip above a space's composer (docs/mobile.md "Activity strip"), on
 * the composer's notes panel (Glass on iOS 26+, a card elsewhere):
 *
 * ```text
 * ⟳ 2 of 5 · Edit auth · 1 queued             1m 12s   line 1: while a turn runs
 * ◌ 2 agents · 2 sub-spaces (1 waiting)            ⌃   line 2: tap ─▶ the activity sheet
 * ```
 *
 * Line 1 waiting on a question reads "Waiting for your answer ↓" and a tap
 * scrolls to the card. The sheet opens like the picker sheets (`useSheet`):
 * an iOS formSheet route, an Android `ModalBottomSheet`, a web modal.
 * The rules are `activity.ts`.
 */
import { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSheet } from '../components/pickers/sheet-host';
import { SymbolImage } from '../components/symbol-image';
import type { SpaceProgress, TurnStep } from '../fleet/contract';
import type { SpaceStatus } from '../fleet/types';
import { track } from '../telemetry/log';
import {
  activityBusy,
  activityHeadline,
  activityLine,
  showsActivity,
} from './activity';
import { Spinner } from './Spinner';
import { usePalette } from './theme';
import { formatDuration } from './turnRows';
import { useActivityView, useNow } from './useActivity';

const android = process.env.EXPO_OS === 'android';

export interface ActivityStripProps {
  space: string;
  status: SpaceStatus;
  /** A question waits (the space's, or one routed here). */
  question: boolean;
  progress: SpaceProgress | null;
  liveSteps: readonly TurnStep[];
  /** When the running turn started (your message's time); none: since
   *  the strip first saw it running. */
  since: number | null;
  /** The newest log line (a host that doesn't mirror its rows). */
  lastLog: string | null;
  queued: number;
  /** "Waiting for your answer ↓" tapped. */
  onWaiting: () => void;
}

/** Whether the strip would draw anything, for the panel around it. */
export function useActivityStrip(
  props: Pick<
    ActivityStripProps,
    | 'space'
    | 'status'
    | 'question'
    | 'progress'
    | 'liveSteps'
    | 'lastLog'
    | 'queued'
  >,
) {
  const view = useActivityView(props.space);
  const line = activityLine(props);
  const headline = activityHeadline(view.agents, view.subs);
  return { view, line, headline, shown: showsActivity(line, headline) };
}

function Timer({ since, now }: { since: number | null; now: number }) {
  const p = usePalette();
  const [start] = useState(() => since ?? now);
  const ms = Math.max(0, now - (since ?? start));
  const s = Math.floor(ms / 1000);
  return (
    <Text
      style={[styles.timer, { color: p.muted }]}
      accessibilityLabel={`running for ${formatDuration(ms)}`}
    >
      {s < 60 ? `${s}s` : formatDuration(s * 1000)}
    </Text>
  );
}

export const ActivityStrip = memo(function ActivityStrip(
  props: ActivityStripProps,
) {
  const p = usePalette();
  const { view, line, headline } = useActivityStrip(props);
  const busy = activityBusy(view.agents, view.subs);
  const now = useNow(!!line?.live);
  const sheet = useSheet('activity', props.space);
  if (!line && !headline) return null;
  return (
    <View style={styles.strip} accessibilityLabel="Activity">
      {line ? (
        <Pressable
          disabled={!line.waiting}
          onPress={() => {
            track('activity_used', { what: 'waiting' });
            props.onWaiting();
          }}
          accessibilityRole={line.waiting ? 'button' : 'text'}
          accessibilityLabel={line.text}
          style={styles.line}
          testID="activity-line"
        >
          <View style={styles.mark}>
            {line.live ? (
              <Spinner color={p.accent} />
            ) : (
              <Text style={[styles.glyph, { color: p.warning }]}>?</Text>
            )}
          </View>
          <Text
            numberOfLines={1}
            style={[styles.text, { color: line.waiting ? p.warning : p.text }]}
          >
            {line.text}
          </Text>
          {line.live ? <Timer since={props.since} now={now} /> : null}
        </Pressable>
      ) : null}
      {headline ? (
        <>
          <Pressable
            onPress={() => {
              track('activity_used', { what: 'headline' });
              sheet.open();
            }}
            accessibilityRole="button"
            accessibilityLabel={`${headline}, opens the activity`}
            accessibilityState={{ expanded: sheet.isOpen }}
            android_ripple={{ color: p.border }}
            style={({ pressed }) => [
              styles.line,
              pressed && !android && styles.pressed,
            ]}
            testID="activity-headline"
          >
            <View style={styles.mark}>
              {busy ? (
                <Spinner color={p.muted} />
              ) : (
                <SymbolImage name="agent" size={13} color={p.muted} />
              )}
            </View>
            <Text numberOfLines={1} style={[styles.text, { color: p.muted }]}>
              {headline}
            </Text>
            <SymbolImage
              name="chevron.down"
              size={12}
              color={p.muted}
              style={{ transform: [{ rotate: '180deg' }] }}
            />
          </Pressable>
          {sheet.element}
        </>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  strip: { gap: 2 },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 24,
  },
  pressed: { opacity: 0.6 },
  mark: { width: 18, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 13, fontWeight: '700' },
  text: { flex: 1, fontSize: 13 },
  timer: { fontSize: 12, fontVariant: ['tabular-nums'] },
});
