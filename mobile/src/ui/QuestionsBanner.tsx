/**
 * Questions routed to this device that nobody answered yet, answerable
 * inline. Home mounts it under its header; it renders nothing
 * when there is none. Shows the oldest first and a toggle for the rest.
 *
 * ```text
 * WAITING FOR YOU · 3          a grouped-list section title (iOS, web) /
 * ┌ question card ─────────┐   a Material label in the accent (Android)
 * └────────────────────────┘
 * 2 more waiting               native plain button; "Show fewer" once open
 * ```
 *
 * `glass`: the cards are Liquid Glass on iOS 26+ (`QuestionCard`). `top`:
 * room for a header that overlays it (`useGlassHeaderInset`), only while
 * it shows.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFleetState } from '../state/fleet';
import { Button } from './native';
import { QuestionCard } from './QuestionCard';
import { usePalette } from './theme';

const android = process.env.EXPO_OS === 'android';

export function QuestionsBanner({
  top = 0,
  glass,
}: {
  top?: number;
  glass?: boolean;
}) {
  const p = usePalette();
  const questions = useFleetState((s) => s.questions);
  const [all, setAll] = useState(false);
  if (questions.length === 0) return null;
  const shown = all ? questions : questions.slice(0, 1);
  const more = questions.length - shown.length;
  const title = android ? 'Waiting for you' : 'WAITING FOR YOU';
  return (
    <View
      style={[
        styles.wrap,
        { backgroundColor: p.background },
        top ? { paddingTop: styles.wrap.paddingTop + top } : null,
      ]}
      accessibilityLabel="Questions waiting for you"
    >
      <Text
        accessibilityRole="header"
        style={[
          android ? styles.titleAndroid : styles.titleIos,
          { color: android ? p.accent : p.muted },
        ]}
      >
        {questions.length > 1 ? `${title} · ${questions.length}` : title}
      </Text>
      {shown.map((q) => (
        <QuestionCard key={q.askId} question={q} glass={glass} />
      ))}
      {more > 0 || (all && questions.length > 1) ? (
        <View style={styles.actions}>
          {more > 0 ? (
            <Button
              variant="plain"
              label={`${more} more waiting`}
              onPress={() => setAll(true)}
            />
          ) : (
            <Button
              variant="plain"
              label="Show fewer"
              onPress={() => setAll(false)}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  titleIos: { fontSize: 13, letterSpacing: 0.2, paddingHorizontal: 4 },
  titleAndroid: { fontSize: 14, fontWeight: '500', paddingHorizontal: 4 },
  actions: { flexDirection: 'row', justifyContent: 'center' },
});
