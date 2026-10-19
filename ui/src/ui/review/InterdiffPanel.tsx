import { useState } from 'react';
import { ToggleButton, ToggleButtonGroup } from '@heroui/react';
import type { MarkedLine } from '../diff';

/** One already-marked line, rendered with its changed-word spans given the
 *  same background the normal diff uses for that side (`--diff-del-word` /
 *  `--diff-add-word`) — inline, since this panel has no `.ln` ancestor for
 *  `styles.css`'s own `.wd` rule to key off. */
function MarkedText({
  line,
  side,
}: {
  line: MarkedLine;
  side: 'previous' | 'now';
}) {
  if (!line.marks.length) return <>{line.text || ' '}</>;
  const bg = `var(${side === 'previous' ? '--diff-del-word' : '--diff-add-word'})`;
  const out: React.ReactNode[] = [];
  let pos = 0;
  line.marks.forEach(([a, b], i) => {
    if (a > pos) out.push(line.text.slice(pos, a));
    out.push(
      <span key={i} style={{ background: bg, borderRadius: 3 }}>
        {line.text.slice(a, b)}
      </span>,
    );
    pos = b;
  });
  if (pos < line.text.length) out.push(line.text.slice(pos));
  return <>{out}</>;
}

/** What changed in a hunk since the baseline you last reviewed (plan §4
 *  re-review): a "previously"/"now" toggle over the core's word-level
 *  `interdiff` diff. Collapsed by default — `DiffPane` only mounts this
 *  once the reviewer asks "what changed". */
export function InterdiffPanel({
  previous,
  now,
}: {
  previous: MarkedLine[];
  now: MarkedLine[];
}) {
  const [side, setSide] = useState<'previous' | 'now'>('now');
  const lines = side === 'previous' ? previous : now;
  return (
    <div className="interdiff flex flex-col gap-2 border-y border-separator bg-surface-secondary px-4 py-2">
      <ToggleButtonGroup
        size="sm"
        selectionMode="single"
        disallowEmptySelection
        aria-label="Previously or now"
        selectedKeys={new Set([side])}
        onSelectionChange={(k) => {
          const next = [...k][0];
          if (next === 'previous' || next === 'now') setSide(next);
        }}
      >
        <ToggleButton id="previous">Previously</ToggleButton>
        <ToggleButton id="now">
          <ToggleButtonGroup.Separator />
          Now
        </ToggleButton>
      </ToggleButtonGroup>
      <div className="font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-foreground">
        {lines.map((l, i) => (
          <div key={i}>
            <MarkedText line={l} side={side} />
          </div>
        ))}
      </div>
    </div>
  );
}
