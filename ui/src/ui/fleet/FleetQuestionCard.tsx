/** A question an agent on another device asks (`ask_user`): the same card
 *  as in a local space (`SpacePlan.QuestionCard`) — options, several when
 *  the question allows, "Other…" — answered through `fleet_answer`. */
import { useState } from 'react';
import { Button, Card, Input, TextField, ToggleButton } from '@heroui/react';
import type { FleetQuestion } from '../../gen/contract';
import { useRootStore } from '../../stores/context';
import {
  emptyDraft,
  isAnswered,
  pickOption,
  toWireAnswers,
  typeOther,
  type Draft,
} from './fleet';

export function FleetQuestionCard({
  question,
  className = '',
}: {
  question: FleetQuestion;
  className?: string;
}) {
  const fleet = useRootStore().fleet;
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    question.questions.map(emptyDraft),
  );
  const [busy, setBusy] = useState(false);
  const set = (i: number, d: Draft) =>
    setDrafts((all) => all.map((x, j) => (j === i ? d : x)));
  const send = () => {
    if (!isAnswered(drafts) || busy) return;
    setBusy(true);
    void fleet
      .answer(question, toWireAnswers(drafts))
      .catch(() => {
        // toasted by api.ts; the card stays to try again
      })
      .finally(() => setBusy(false));
  };
  return (
    <Card
      variant="secondary"
      className={`fleet-question flex flex-col gap-4 px-4 py-3 ${className}`}
      data-ask={question.ask_id}
    >
      <span className="text-xs font-medium text-muted">
        {question.from} is waiting for your answer
      </span>
      {question.questions.map((q, i) => {
        const d = drafts[i] ?? emptyDraft();
        return (
          <div key={i} className="flex flex-col gap-2">
            <span className="text-sm font-medium">{q.question}</span>
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((o) => (
                <ToggleButton
                  key={o}
                  size="sm"
                  className="fleet-option"
                  isSelected={d.selected.includes(o)}
                  onChange={() => set(i, pickOption(q, d, o))}
                >
                  {o}
                </ToggleButton>
              ))}
            </div>
            <TextField
              value={d.other}
              onChange={(t) => set(i, typeOther(q, d, t))}
              aria-label={`Other answer to: ${q.question}`}
            >
              <Input
                className="text-sm"
                placeholder="Other…"
                onKeyDown={(e) => e.key === 'Enter' && send()}
              />
            </TextField>
            {q.multi && (
              <span className="text-[11px] text-muted">
                Pick any that apply
              </span>
            )}
          </div>
        );
      })}
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="primary"
          className="fleet-answer"
          isDisabled={!isAnswered(drafts)}
          isPending={busy}
          onPress={send}
        >
          Send answer
        </Button>
      </div>
    </Card>
  );
}
