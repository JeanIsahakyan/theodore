/**
 * A note in a space's timeline: another space's agent, or one of your
 * devices, asked this space something (`space_ask` / `ask_space`). One muted
 * line; the answer opens under it. Not part of the space's conversation: its
 * agent never sees it (docs/spaces.md "Sub-spaces, and asking other spaces").
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from '@gravity-ui/icons';
import { observer } from 'mobx-react-lite';
import type { AskedBy, SpaceNote } from '../../gen/contract';
import { useRootStore, useUi } from '../../stores/context';
import { Md } from '../../highlight';
import { modelLabel } from '../agentModel';
import { spaceTitle } from './spaces';

/** The question's first line. */
function oneLine(s: string): string {
  const line = s.trim().split('\n', 1)[0] ?? '';
  return line.length < s.trim().length ? `${line}…` : line;
}

/** Who answered, and from what: `claude · Opus · forked session`. */
export function answeredBy(ask: SpaceNote['ask']): string {
  const parts: string[] = [];
  if (ask.agent)
    parts.push(ask.agent, modelLabel(ask.agent, ask.model ?? null));
  if (ask.how === 'fork') parts.push('forked session');
  else if (ask.how === 'fresh') parts.push('fresh read');
  return parts.join(' · ');
}

export function AskNoteRow({ note }: { note: SpaceNote }) {
  const [open, setOpen] = useState(false);
  const { ask } = note;
  const by = answeredBy(ask);
  return (
    <div
      data-note={note.id}
      data-variant="space-note"
      role="note"
      title={new Date(note.at).toLocaleString()}
      className="space-note flex flex-col items-center gap-1.5 px-4 text-xs text-muted"
    >
      <div className="flex max-w-full items-center whitespace-pre">
        <span className="shrink-0">{'Asked by '}</span>
        <Asker from={ask.from} />
        <button
          type="button"
          aria-expanded={open}
          className="space-note-toggle flex min-w-0 items-center gap-1 whitespace-pre hover:text-foreground"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="truncate">: {oneLine(ask.question)}</span>
          {open ? (
            <ChevronDown className="size-3 shrink-0" />
          ) : (
            <ChevronRight className="size-3 shrink-0" />
          )}
        </button>
      </div>
      {open && (
        <div className="space-note-answer flex w-full max-w-2xl flex-col gap-1.5 rounded-xl bg-surface px-3 py-2 text-left">
          {ask.question.includes('\n') && (
            <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              {ask.question}
            </p>
          )}
          {ask.answer != null ? (
            <div className="text-sm leading-relaxed text-foreground">
              <Md text={ask.answer} />
            </div>
          ) : (
            <span className="space-note-failed">
              No answer: {ask.failed ?? 'it failed'}
            </span>
          )}
          {by && <span className="space-note-by">{by}</span>}
        </div>
      )}
    </div>
  );
}

/** The asking space, opening it (plain once it is gone), or the device. */
const Asker = observer(function Asker({ from }: { from: AskedBy }) {
  const store = useRootStore();
  const ui = useUi();
  if (from.kind === 'device') {
    return <span className="space-note-from truncate">{from.name}</span>;
  }
  const space = store.models.spaces.get(from.space);
  const label = space ? spaceTitle(space) : from.title;
  if (!space) return <span className="space-note-from truncate">{label}</span>;
  return (
    <button
      type="button"
      className="space-note-from truncate hover:text-foreground hover:underline"
      onClick={() => ui.go({ name: 'space', id: space.id })}
    >
      {label}
    </button>
  );
});
