/**
 * A question an agent on another device asks (`ask_user`): options, several
 * when the question allows, "Other…" free text, answered through
 * `fleet.answer(space, askId, answers)`. Drawn like the chat template's
 * cards, with native controls: options as pills (`OptionChip`), the
 * "Other…" field (`ChatField`), Send answer a pill (the kit's `Button`).
 * `glass` (the banner on Home): a Liquid Glass card on iOS 26+, tinted
 * with the warning color; the plain card elsewhere.
 *
 * ```text
 * ╭──────────────────────────────────────────╮
 * │ ● mac-A · fix-login is waiting for you…  │
 * │ Which database?                          │
 * │ (Postgres) (✓ SQLite) (MySQL)            │   pills; several if multi
 * │ ( Other…                              )  │
 * │ (              Send answer             ) │
 * ╰──────────────────────────────────────────╯
 *
 * Send answer ─▶ at once:  ╭ ◌ Answered: SQLite ╮   (src/state/pending.ts)
 *   the host's row drops the question ─▶ the card is gone
 *   refused / no answer in time ─▶ the card is back, the error under it
 * ```
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useServices } from '../services';
import { useFleetState } from '../state/fleet';
import { addAnswer, dropAnswer, usePending } from '../state/pending';
import type { QuestionView } from '../fleet/types';
import { track } from '../telemetry/log';
import { ChatField } from './ChatField';
import { Notice } from './kit';
import {
  emptyDraft,
  errorText,
  isAnswered,
  pickOption,
  questionFrom,
  refusalCode,
  toWireAnswers,
  typeOther,
  type Draft,
} from './logic';
import { Button, Glass, liquidGlass } from './native';
import { OptionChip } from './OptionChip';
import { answeredLabel } from './pending';
import { Spinner } from './Spinner';
import { usePalette } from './theme';

export function QuestionCard({
  question,
  onFocusAnswer,
  glass,
  answer,
  from: fromOverride,
  surface,
}: {
  question: QuestionView;
  /** The "Other…" field took focus: the host keeps the card in view. */
  onFocusAnswer?: () => void;
  /** On Liquid Glass (iOS 26+) rather than a card. */
  glass?: boolean;
  /** How the answer goes out; default `fleet.answer` for a followed space
   *  (a sub-space's goes with `answerSpace`). */
  answer?: (answers: string[][]) => Promise<void>;
  /** Who asks, when the space isn't followed here (a sub-space). */
  from?: string;
  /** Where the card is (telemetry): a followed space, Home's banner, a
   *  sub-space. */
  surface?: 'space' | 'home' | 'sub_space';
}) {
  const { fleet } = useServices();
  const p = usePalette();
  const spaces = useFleetState((s) => s.spaces);
  const given = usePending((s) => s.answers[question.askId]);
  const from = fromOverride ?? questionFrom(question, spaces);
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    question.questions.map(emptyDraft),
  );
  const [error, setError] = useState<string | null>(null);

  const set = (i: number, d: Draft) =>
    setDrafts((all) => all.map((x, j) => (j === i ? d : x)));

  const send = () => {
    if (!isAnswered(drafts) || given) return;
    setError(null);
    const wire = toWireAnswers(drafts);
    // Shown as answered at once; the host's word only brings it back.
    addAnswer(question.askId, question.space, answeredLabel(drafts));
    const facts = {
      surface: surface ?? 'space',
      over: 'socket',
      questions: question.questions.length,
    };
    (answer ? answer(wire) : fleet.answer(question.space, question.askId, wire))
      .then(() =>
        track('question_answered', { ...facts, outcome: 'ok', code: null }),
      )
      .catch((e: unknown) => {
        track('question_answered', {
          ...facts,
          outcome: 'failed',
          code: refusalCode(e),
        });
        dropAnswer(question.askId);
        setError(errorText(e));
      });
  };

  const content = given ? (
    <View style={styles.head} accessibilityLabel={given.label}>
      <Spinner color={p.muted} />
      <Text
        numberOfLines={2}
        selectable
        style={[styles.answered, { color: p.muted }]}
      >
        {given.label}
      </Text>
    </View>
  ) : (
    <>
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: p.warning }]} />
        <Text selectable style={[styles.from, { color: p.warning }]}>
          {from} is waiting for your answer
        </Text>
      </View>
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
                  onPress={() => set(i, pickOption(q, d, o))}
                />
              ))}
            </View>
            <ChatField
              accessibilityLabel={`Other answer to: ${q.question}`}
              placeholder="Other…"
              value={d.other}
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
        pill
        fullWidth
        disabled={!isAnswered(drafts)}
        onPress={send}
      />
    </>
  );

  return glass && liquidGlass ? (
    <Glass radius={22} tint={`${p.warning}26`} style={styles.card}>
      {content}
    </Glass>
  ) : (
    <View
      className="rounded-[22px] border bg-card"
      style={[styles.card, { borderColor: `${p.warning}66` }]}
    >
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  from: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  answered: { fontSize: 14, flexShrink: 1 },
  item: { gap: 10 },
  question: { fontSize: 16, fontWeight: '600', lineHeight: 22 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hint: { fontSize: 12 },
  card: { padding: 16, gap: 12, borderCurve: 'continuous' },
});
