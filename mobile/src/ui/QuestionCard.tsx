/**
 * A question an agent on another device asks (`ask_user`): options, several
 * when the question allows, "Other…" free text, answered through
 * `fleet.answer(space, askId, answers)`. Same card as the desktop's.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useServices } from '../services';
import { useFleetState } from '../state/fleet';
import type { QuestionView } from '../fleet/types';
import { Button, Card, Chip, Field, Notice } from './kit';
import {
  emptyDraft,
  errorText,
  isAnswered,
  pickOption,
  questionFrom,
  toWireAnswers,
  typeOther,
  type Draft,
} from './logic';
import { usePalette } from './theme';

export function QuestionCard({
  question,
  onFocusAnswer,
}: {
  question: QuestionView;
  /** The "Other…" field took focus: the host keeps the card in view. */
  onFocusAnswer?: () => void;
}) {
  const { fleet } = useServices();
  const p = usePalette();
  const spaces = useFleetState((s) => s.spaces);
  const from = questionFrom(question, spaces);
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    question.questions.map(emptyDraft),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (i: number, d: Draft) =>
    setDrafts((all) => all.map((x, j) => (j === i ? d : x)));

  const send = () => {
    if (!isAnswered(drafts) || busy) return;
    setBusy(true);
    setError(null);
    fleet
      .answer(question.space, question.askId, toWireAnswers(drafts))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Card style={{ borderColor: p.warning }}>
      <Text selectable style={[styles.from, { color: p.warning }]}>
        {from} is waiting for your answer
      </Text>
      {question.questions.map((q, i) => {
        const d = drafts[i] ?? emptyDraft();
        return (
          <View key={i} style={styles.item}>
            <Text selectable style={[styles.question, { color: p.text }]}>
              {q.question}
            </Text>
            <View style={styles.options}>
              {q.options.map((o) => (
                <Chip
                  key={o}
                  label={o}
                  selected={d.selected.includes(o)}
                  disabled={busy}
                  onPress={() => set(i, pickOption(q, d, o))}
                />
              ))}
            </View>
            <Field
              label={`Other answer to: ${q.question}`}
              placeholder="Other…"
              value={d.other}
              editable={!busy}
              onChangeText={(t) => set(i, typeOther(q, d, t))}
              onFocus={onFocusAnswer}
              onSubmitEditing={send}
              returnKeyType="send"
            />
            {q.multi ? (
              <Text style={[styles.hint, { color: p.muted }]}>
                Pick any that apply
              </Text>
            ) : null}
          </View>
        );
      })}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button
        label="Send answer"
        kind="primary"
        disabled={!isAnswered(drafts)}
        busy={busy}
        onPress={send}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  from: { fontSize: 13, fontWeight: '600' },
  item: { gap: 8 },
  question: { fontSize: 16, fontWeight: '600' },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hint: { fontSize: 12 },
});
