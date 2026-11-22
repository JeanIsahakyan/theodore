/**
 * Long-pressing a message (docs/mobile.md "Select text"): the menu's items
 * per kind of message, and the text the Select text sheet shows, without
 * React. Views: `src/components/chat/long-press{.web,}.tsx`,
 * `select-text-sheet.tsx`.
 *
 * ```text
 * long press ─▶ Copy (the whole text) · Select text · <the row's own actions> · Cancel
 * Select text ─▶ a sheet: the message as plain text in a read-only field,
 *                the system's selection handles; code blocks monospace; Copy all
 * ```
 */

/** Whose words: the agent's reply, your message, a step's text or output. */
export type MessageKind = 'reply' | 'mine' | 'step';

export interface MenuAction {
  id: string;
  label: string;
  destructive?: boolean;
}

export const COPY = { id: 'copy', label: 'Copy' } as const;
export const SELECT_TEXT = { id: 'select', label: 'Select text' } as const;
export const CANCEL = { id: 'cancel', label: 'Cancel' } as const;

/** The sheet's and the menu's title per kind. */
export const KIND_TITLE: Record<MessageKind, string> = {
  reply: 'Reply',
  mine: 'Your message',
  step: 'Step',
};

/**
 * The items, in order: Copy, Select text, then `extras` (a row's own
 * actions), Cancel last (platforms that show one). Nothing to copy: no
 * menu at all.
 */
export function messageMenuItems(
  kind: MessageKind,
  text: string,
  extras: readonly MenuAction[] = [],
): MenuAction[] {
  if (!text.trim()) return [];
  const own: MenuAction[] = [COPY, SELECT_TEXT];
  const more = extras.filter(
    (a) => a.id !== COPY.id && a.id !== SELECT_TEXT.id && a.id !== CANCEL.id,
  );
  return [...own, ...more];
}

// ── the sheet's text ────────────────────────────────────────────────────────

/** A run of the message: prose, or a fenced code block's body. */
export interface TextSegment {
  kind: 'text' | 'code';
  text: string;
}

const FENCE = /^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1[ \t]*$/m;

/**
 * The message split at its fenced code blocks: the fences go, the code
 * stays as it is (drawn monospace); the rest is the markdown as written.
 */
export function textSegments(markdown: string): TextSegment[] {
  const out: TextSegment[] = [];
  let rest = markdown;
  for (;;) {
    const m = FENCE.exec(rest);
    if (!m) break;
    const before = rest.slice(0, m.index);
    if (before.trim()) out.push({ kind: 'text', text: before });
    out.push({ kind: 'code', text: m[3] ?? '' });
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest.trim()) out.push({ kind: 'text', text: rest });
  return out.length ? out : [{ kind: 'text', text: markdown }];
}

/** Most text the sheet shows (a field this long still scrolls well). */
export const SELECT_TEXT_MAX = 100_000;

/** The sheet's text: cut when very long, with a note. */
export function sheetText(text: string): { text: string; cut: boolean } {
  if (text.length <= SELECT_TEXT_MAX) return { text, cut: false };
  return { text: text.slice(0, SELECT_TEXT_MAX), cut: true };
}

export const COPY_ALL_TEXT = 'Copy all';
export const COPIED_TEXT = 'Copied';
