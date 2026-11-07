/**
 * A space's chat as rows: one per turn, so a long chat only has to mount the
 * turns near the view.
 *
 * ```text
 * head   setup stage / note             stays mounted
 * turn   you ─ reply, timeline, cards   keyed by your message's id
 * turn   …
 * turn   you ─ the live reply
 * tail   queued messages, the question  stays mounted
 * ```
 */
import type { ChatMessage } from '../../gen/contract';

export interface ChatTurn {
  key: string;
  messages: ChatMessage[];
}

export type ChatRow =
  | { kind: 'head'; key: 'head' }
  | { kind: 'turn'; key: string; messages: ChatMessage[]; live: boolean }
  /** A running turn before its message arrived. */
  | { kind: 'live'; key: 'live' }
  | { kind: 'tail'; key: 'tail' };

/** The transcript by time, as turns: each of your messages with the replies
 *  under it. A reply with no message before it starts its own. `keyOf`: a
 *  message's row key, when it differs from its id. */
export function pairTurns(
  sent: readonly ChatMessage[],
  keyOf: (id: string) => string = (id) => id,
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const m of sent) {
    const last = turns.at(-1);
    if (m.author.kind === 'me' || !last) {
      turns.push({ key: keyOf(m.id), messages: [m] });
    } else {
      last.messages.push(m);
    }
  }
  return turns;
}

/** The rows, in the order the chat shows them. The live reply goes on the
 *  last turn: it is what that turn is waiting for, and it stays in the same
 *  row when its reply lands. */
export function chatRows(
  turns: readonly ChatTurn[],
  has: { head: boolean; live: boolean; tail: boolean },
): ChatRow[] {
  const rows: ChatRow[] = [];
  if (has.head) rows.push({ kind: 'head', key: 'head' });
  turns.forEach((t, i) =>
    rows.push({
      kind: 'turn',
      key: t.key,
      messages: t.messages,
      live: has.live && i === turns.length - 1,
    }),
  );
  if (has.live && turns.length === 0) rows.push({ kind: 'live', key: 'live' });
  if (has.tail) rows.push({ kind: 'tail', key: 'tail' });
  return rows;
}

/** Per line of text in the reading column, about. */
const LINE = 22;
const CHARS_PER_LINE = 90;
/** A message's bubble or header and footer, without its text. */
const MESSAGE = 72;
const GAP = 20;

/** A row's height before it was measured: near enough that scrolling up
 *  through rows nobody saw yet has little to correct. */
export function estimateRowHeight(row: ChatRow): number {
  if (row.kind !== 'turn') return row.kind === 'live' ? 120 : 80;
  let height = GAP + (row.live ? 120 : 0);
  for (const m of row.messages) {
    const lines = m.text.split('\n').reduce((n, line) => {
      return n + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE));
    }, 0);
    height += MESSAGE + lines * LINE + GAP;
  }
  return height;
}
