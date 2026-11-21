/**
 * `@` in a space's composer (docs/spaces.md "Mentions"): a picker of the
 * other spaces, local and mirrored, recent first, filtered as you type.
 * A pick becomes a chip over the box; on send the ids go with the message
 * (`SpaceSendRequest.mentions`) and the core adds each space's context to
 * the turn's prompt. The sent message shows the chips, each opening its
 * space.
 *
 * ```text
 * "…@par" ─▶ menu: [This space: @terminal]  Spaces: Port the parser · …
 *   ⏎ / Tab / click ─▶ "@par" out of the box, chip in ─▶ send { mentions }
 *   Esc ─▶ menu shut until the text changes
 * ```
 *
 * `@terminal ` (docs/spaces.md §3) still attaches the terminal when typed
 * out; the menu offers it as its first row while the word fits.
 */
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { At, Terminal, Xmark } from '@gravity-ui/icons';
import { Card, ListBox } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { Space, SpaceMention } from '../../gen/contract';
import { useRootStore, useUi } from '../../stores/context';
import { skillMenuKey } from '../SkillMenu';
import { spaceTitle } from './spaces';

/** Rows the picker shows at most. */
const MENU_ROWS = 8;
/** Spaces one message mentions at most (the core's `MENTIONS_MAX`). */
export const MENTIONS_MAX = 5;

/** The `@word` being typed at the end of `text`: what follows `@` and
 *  where the `@` is. `null` when the text doesn't end in one. */
export function mentionQuery(
  text: string,
): { query: string; start: number } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text);
  if (!m) return null;
  return { query: m[2]!, start: m.index + m[1]!.length };
}

/** A space as a picker row says it. */
export interface MentionRow {
  id: string;
  title: string;
  project: string;
  status: string;
  /** The device it runs on, for a mirrored one. */
  host: string | null;
  archived: boolean;
}

/** What a space is doing, in a word. */
export function mentionStatus(
  s: Pick<Space, 'status' | 'question' | 'setup'>,
): string {
  if (s.status === 'archived') return 'archived';
  if (s.question) return 'waiting for you';
  if (s.setup?.status === 'running') return 'setting up';
  if (s.status === 'running') return 'running';
  if (s.status === 'failed') return 'failed';
  return 'idle';
}

/** The spaces `query` picks, `current` and the already `taken` left out:
 *  most recently active first, archived ones only once searched for and
 *  after the rest. Matches the title, project, host or branch. */
export function matchMentionSpaces(
  spaces: Space[],
  current: string,
  query: string,
  projectName: (id: string) => string | undefined,
  taken: string[] = [],
): MentionRow[] {
  const q = query.trim().toLowerCase();
  return spaces
    .filter((s) => s.id !== current && !taken.includes(s.id))
    .filter((s) => s.status !== 'archived' || q.length > 0)
    .map((s) => ({
      space: s,
      row: {
        id: s.id,
        title: spaceTitle(s),
        project: s.remote?.project_name ?? projectName(s.project) ?? s.project,
        status: mentionStatus(s),
        host: s.remote?.host_name ?? null,
        archived: s.status === 'archived',
      },
    }))
    .filter(
      ({ space, row }) =>
        !q ||
        [row.title, row.project, row.host ?? '', space.branch].some((x) =>
          x.toLowerCase().includes(q),
        ),
    )
    .sort(
      (a, b) =>
        Number(a.row.archived) - Number(b.row.archived) ||
        b.space.updated_at - a.space.updated_at,
    )
    .slice(0, MENU_ROWS)
    .map(({ row }) => row);
}

/** A menu row: the terminal, or a space. */
export type MentionPick =
  { kind: 'terminal' } | { kind: 'space'; row: MentionRow };

/** The rows for `query`: `@terminal` first while the word fits (a space
 *  of this device only), then the spaces. */
export function mentionPicks(
  rows: MentionRow[],
  query: string,
  terminal: boolean,
): MentionPick[] {
  const q = query.toLowerCase();
  const term: MentionPick[] =
    terminal && 'terminal'.startsWith(q) ? [{ kind: 'terminal' }] : [];
  return [...term, ...rows.map((row) => ({ kind: 'space' as const, row }))];
}

const pickKey = (p: MentionPick) =>
  p.kind === 'terminal' ? 'terminal' : `space:${p.row.id}`;

function SpaceMentionMenu({
  picks,
  hi,
  onHover,
  onPick,
}: {
  picks: MentionPick[];
  hi: number;
  onHover: (i: number) => void;
  onPick: (p: MentionPick) => void;
}) {
  const at = Math.min(hi, picks.length - 1);
  const firstSpace = picks.findIndex((p) => p.kind === 'space');
  return (
    <Card className="mention-menu min-w-0 gap-0 p-1.5 shadow-overlay">
      <ListBox
        aria-label="Mention"
        selectionMode="none"
        onAction={(k) => {
          const p = picks.find((x) => pickKey(x) === String(k));
          if (p) onPick(p);
        }}
        className="max-h-80 overflow-y-auto p-0"
      >
        {picks.map((p, i) => (
          <ListBox.Item
            key={pickKey(p)}
            id={pickKey(p)}
            textValue={p.kind === 'terminal' ? 'terminal' : p.row.title}
            onHoverStart={() => onHover(i)}
            className={`min-w-0 flex-col items-start gap-0.5 rounded-2xl px-3 py-2 ${i === at ? 'bg-default' : ''}`}
          >
            {i === firstSpace && (
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
                Spaces
              </span>
            )}
            {p.kind === 'terminal' ? (
              <span className="flex w-full min-w-0 items-center gap-2">
                <Terminal className="size-3.5 shrink-0 text-muted" />
                <span className="truncate font-mono text-sm">@terminal</span>
                <span className="ms-auto shrink-0 text-xs text-muted">
                  the terminal's last lines
                </span>
              </span>
            ) : (
              <>
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="truncate text-sm">{p.row.title}</span>
                  <span className="ms-auto shrink-0 text-xs text-muted">
                    {p.row.status}
                  </span>
                </span>
                <span className="w-full truncate text-xs text-muted">
                  {p.row.project}
                  {p.row.host ? ` · on ${p.row.host}` : ''}
                </span>
              </>
            )}
          </ListBox.Item>
        ))}
      </ListBox>
    </Card>
  );
}

/** The chips over the box: a space each, × takes it out. */
function MentionChips({
  mentions,
  onRemove,
}: {
  mentions: SpaceMention[];
  onRemove: (id: string) => void;
}) {
  if (!mentions.length) return null;
  return (
    <div className="mention-strip flex w-full flex-wrap gap-1.5 px-3 pb-1">
      {mentions.map((m) => (
        <span
          key={m.space}
          className="mention-chip inline-flex h-8 max-w-56 shrink-0 items-center gap-1 rounded-full bg-default pe-1 ps-2.5 text-xs"
          title={m.host ? `${m.title} · on ${m.host}` : m.title}
        >
          <At className="size-3 shrink-0 text-muted" />
          <span className="min-w-0 truncate">{m.title}</span>
          <button
            type="button"
            aria-label={`Remove ${m.title}`}
            className="grid size-6 shrink-0 place-items-center rounded-full text-muted hover:bg-foreground/10 hover:text-foreground"
            onClick={() => onRemove(m.space)}
          >
            <Xmark className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

/** The composer's side of mentions in `space`: the menu (and its keys),
 *  the chips, and what a send takes. `text` / `setText`: the box. */
export function useSpaceMentions({
  space,
  spaces,
  projectName,
  text,
  setText,
  onTerminal,
  focus,
}: {
  space: string;
  /** Every space this device knows, mirrors included; read only while
   *  the menu is open. */
  spaces: () => Space[];
  projectName: (id: string) => string | undefined;
  text: string;
  setText: (t: string) => void;
  /** `@terminal` picked; none: not offered (a remote space). */
  onTerminal?: () => void;
  focus: () => void;
}): {
  menu: { node: ReactNode; onKey: (e: KeyboardEvent) => boolean } | undefined;
  chips: ReactNode;
  mentions: SpaceMention[];
  clear: () => void;
  restore: (m: SpaceMention[]) => void;
  popLast: () => boolean;
} {
  const [mentions, setMentions] = useState<SpaceMention[]>([]);
  // Esc shuts the menu for this text; typing opens it again.
  const [shutFor, setShutFor] = useState<string | null>(null);
  const [hiAt, setHiAt] = useState({ text: '', i: 0 });
  const q = shutFor === text ? null : mentionQuery(text);
  const full = mentions.length >= MENTIONS_MAX;
  const picks = q
    ? mentionPicks(
        full
          ? []
          : matchMentionSpaces(
              spaces(),
              space,
              q.query,
              projectName,
              mentions.map((m) => m.space),
            ),
        q.query,
        !!onTerminal,
      )
    : null;
  const hi = hiAt.text === text ? hiAt.i : 0;
  const setHi = (f: (n: number) => number) => setHiAt({ text, i: f(hi) });
  const pick = (p: MentionPick) => {
    if (!q) return;
    setText(text.slice(0, q.start));
    if (p.kind === 'terminal') {
      onTerminal?.();
    } else {
      const { row } = p;
      setMentions((list) =>
        list.some((m) => m.space === row.id)
          ? list
          : [...list, { space: row.id, title: row.title, host: row.host }],
      );
    }
    focus();
  };
  const open = picks && picks.length > 0 ? picks : null;
  return {
    menu: q
      ? {
          node: open ? (
            <SpaceMentionMenu
              picks={open}
              hi={hi}
              onHover={(i) => setHi(() => i)}
              onPick={pick}
            />
          ) : null,
          onKey: (e) =>
            skillMenuKey(e, open, hi, setHi, pick, () => setShutFor(text)),
        }
      : undefined,
    chips: (
      <MentionChips
        mentions={mentions}
        onRemove={(id) =>
          setMentions((list) => list.filter((m) => m.space !== id))
        }
      />
    ),
    mentions,
    clear: () => setMentions([]),
    restore: (m) => setMentions(m),
    popLast: () => {
      if (!mentions.length) return false;
      setMentions((list) => list.slice(0, -1));
      return true;
    },
  };
}

/** Over a sent message: the spaces it mentioned, each opening its space;
 *  plain text once that space is gone. */
export const MentionLinks = observer(function MentionLinks({
  mentions,
}: {
  mentions: SpaceMention[];
}) {
  const store = useRootStore();
  const ui = useUi();
  return (
    <span className="message-mentions flex min-w-0 flex-wrap items-center gap-1">
      {mentions.map((m) => {
        const space = store.models.spaces.get(m.space);
        const title = space ? spaceTitle(space) : m.title;
        const label = (
          <>
            <At className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{title}</span>
          </>
        );
        const cls =
          'mention-link inline-flex max-w-56 items-center gap-1 rounded-full bg-default px-2 py-0.5 text-[11px]';
        return space ? (
          <button
            key={m.space}
            type="button"
            className={`${cls} text-foreground hover:underline`}
            title={m.host ? `${title} · on ${m.host}` : title}
            onClick={() => ui.go({ name: 'space', id: space.id })}
          >
            {label}
          </button>
        ) : (
          <span
            key={m.space}
            className={`${cls} text-muted`}
            title={`${m.title}: no longer here`}
          >
            {label}
          </span>
        );
      })}
    </span>
  );
});
