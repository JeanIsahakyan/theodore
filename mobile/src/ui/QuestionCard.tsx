/**
 * A question an agent on another device asks (`ask_user`): options, several
 * when the question allows, "Other…" free text, answered through
 * `fleet.answer(space, askId, answers)`. Same card as the desktop's, with
 * native controls: option chips (`OptionChip`), the "Other…" field
 * (`ChatField`) and Send answer (the kit's `Button`). `glass` (the banner
 * on Home): a Liquid Glass card on iOS 26+, tinted with the warning
 * color; the plain card elsewhere.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useServices } from '../services';
import { useFleetState } from '../state/fleet';
import type { QuestionView } from '../fleet/types';
import { ChatField } from './ChatField';
import { Card, Notice } from './kit';
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
import { Button, Glass, liquidGlass } from './native';
import { OptionChip } from './OptionChip';
import { usePalette } from './theme';

export function QuestionCard({
  question,
  onFocusAnswer,
  glass,
}: {
  question: QuestionView;
  /** The "Other…" field took focus: the host keeps the card in view. */
  onFocusAnswer?: () => void;
  /** On Liquid Glass (iOS 26+) rather than a card. */
  glass?: boolean;
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

  const content = (
    <>
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
                <OptionChip
                  key={o}
                  label={o}
                  selected={d.selected.includes(o)}
                  disabled={busy}
                  onPress={() => set(i, pickOption(q, d, o))}
                />
              ))}
            </View>
            <ChatField
              accessibilityLabel={`Other answer to: ${q.question}`}
              placeholder="Other…"
              value={d.other}
              disabled={busy}
              onChangeText={(t) => set(i, typeOther(q, d, t))}
              onFocus={onFocusAnswer}
              onSubmit={send}
              submitLabel="send"
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
        variant={glass ? 'glassProminent' : 'primary'}
        fullWidth
        disabled={!isAnswered(drafts)}
        loading={busy}
        onPress={send}
      />
    </>
  );

  return glass && liquidGlass ? (
    <Glass radius={22} tint={`${p.warning}26`} style={styles.glass}>
      {content}
    </Glass>
  ) : (
    <Card style={{ borderColor: p.warning }}>{content}</Card>
  );
}

const styles = StyleSheet.create({
  from: { fontSize: 13, fontWeight: '600' },
  item: { gap: 8 },
  question: { fontSize: 16, fontWeight: '600' },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hint: { fontSize: 12 },
  glass: { padding: 14, gap: 8 },
});
