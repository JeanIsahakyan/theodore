/**
 * Questions routed to this device that nobody answered yet, answerable
 * inline. The shell mounts it at the top of the tabs; it renders nothing
 * when there is none. Shows the oldest first and a toggle for the rest.
 */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFleetState } from '../state/fleet';
import { Button } from './kit';
import { QuestionCard } from './QuestionCard';

export function QuestionsBanner() {
  const questions = useFleetState((s) => s.questions);
  const [all, setAll] = useState(false);
  if (questions.length === 0) return null;
  const shown = all ? questions : questions.slice(0, 1);
  const more = questions.length - shown.length;
  return (
    <View style={styles.wrap} accessibilityLabel="Questions waiting for you">
      {shown.map((q) => (
        <QuestionCard key={q.askId} question={q} />
      ))}
      {more > 0 ? (
        <Button
          kind="plain"
          label={`${more} more waiting`}
          onPress={() => setAll(true)}
        />
      ) : null}
      {all && questions.length > 1 ? (
        <Button kind="plain" label="Show fewer" onPress={() => setAll(false)} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({ wrap: { gap: 8, padding: 12 } });
