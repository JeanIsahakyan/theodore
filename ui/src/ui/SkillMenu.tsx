/**
 * The `/` skills list over a chat box: the review AI panel (runs the skill
 * on the PR) and a space's chat (puts `/skill ` in the box for the turn).
 */
import type { KeyboardEvent, ReactNode } from 'react';
import { Card, ListBox } from '@heroui/react';
import type { SkillInfo } from '../gen/contract';

/** Skills matching what's typed after `/`, nothing once a space ends the name. */
export function matchSkills(
  skills: SkillInfo[],
  text: string,
): SkillInfo[] | null {
  if (!text.startsWith('/') || /\s/.test(text)) return null;
  const q = text.slice(1).toLowerCase();
  return skills.filter(
    (s) => s.id.toLowerCase().includes(q) || s.title.toLowerCase().includes(q),
  );
}

/** The box's keys while the list is open: ↑ ↓ move, Tab / ⏎ pick, Esc
 *  closes. `true` when the key was the list's. */
export function skillMenuKey(
  e: KeyboardEvent,
  matches: SkillInfo[] | null,
  hi: number,
  setHi: (f: (n: number) => number) => void,
  pick: (s: SkillInfo) => void,
  close: () => void,
): boolean {
  if (!matches) return false;
  if (e.key === 'Escape') {
    // Esc closes the list, not the page or dialog.
    e.preventDefault();
    e.stopPropagation();
    close();
    return true;
  }
  if (!matches.length) return false;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setHi((n) => Math.min(matches.length - 1, n + 1));
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    setHi((n) => Math.max(0, n - 1));
    return true;
  }
  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
    e.preventDefault();
    pick(matches[Math.min(hi, matches.length - 1)]!);
    return true;
  }
  return false;
}

export function SkillMenu({
  matches,
  hi,
  onHover,
  onPick,
  footer,
}: {
  matches: SkillInfo[];
  hi: number;
  onHover: (i: number) => void;
  onPick: (s: SkillInfo) => void;
  footer?: ReactNode;
}) {
  return (
    <Card className="slash-menu min-w-0 gap-0 p-1.5 shadow-overlay">
      <ListBox
        aria-label="Skills"
        selectionMode="none"
        onAction={(k) => {
          const s = matches.find((x) => x.id === String(k));
          if (s) onPick(s);
        }}
        className="max-h-72 overflow-y-auto p-0"
      >
        {matches.map((s, i) => (
          <ListBox.Item
            key={s.id}
            id={s.id}
            textValue={s.title}
            onHoverStart={() => onHover(i)}
            className={`min-w-0 flex-col items-start gap-0.5 rounded-2xl px-3 py-2 ${i === Math.min(hi, matches.length - 1) ? 'bg-default' : ''}`}
          >
            <span className="flex w-full min-w-0 items-center gap-2">
              <span className="truncate font-mono text-sm">/{s.id}</span>
              <span className="ms-auto max-w-40 shrink-0 truncate text-xs text-muted">
                {s.source}
              </span>
            </span>
            <span
              className="line-clamp-2 w-full text-xs text-muted"
              title={s.description}
            >
              {s.description}
            </span>
          </ListBox.Item>
        ))}
      </ListBox>
      {footer}
    </Card>
  );
}
