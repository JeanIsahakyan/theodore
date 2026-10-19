import { Card, Chip } from '@heroui/react';
import { Code, langOf } from '../highlight';
import type { Patch } from '../gen/contract';
import { AgentTag } from './bits';

/** An agent's patch as a small diff: what it removes, what it puts instead. */
export function PatchView({
  patch,
  status,
}: {
  patch: Patch;
  status?: string;
}) {
  const lang = langOf(patch.path);
  return (
    <Card variant="secondary" className="patch gap-0 overflow-hidden p-0">
      <div className="flex min-w-0 items-center gap-2 border-b border-separator px-3 py-2 text-xs">
        <AgentTag id={patch.by} />
        <span
          className="min-w-0 flex-1 truncate font-mono text-muted"
          title={patch.path}
        >
          {patch.path}
        </span>
        {status && (
          <Chip
            size="sm"
            variant="soft"
            className="shrink-0"
            color={status === 'rejected' ? 'default' : 'success'}
          >
            {status}
          </Chip>
        )}
      </div>
      <div className="lines overflow-x-auto bg-surface py-1 [&_.src]:overflow-visible">
        {patch.before.map((s, i) => (
          <div
            key={`b${i}`}
            className="ln t-del"
            style={{ gridTemplateColumns: '20px max-content' }}
          >
            <span className="mark">−</span>
            <Code s={s} lang={lang} />
          </div>
        ))}
        {patch.after.map((s, i) => (
          <div
            key={`a${i}`}
            className="ln t-add"
            style={{ gridTemplateColumns: '20px max-content' }}
          >
            <span className="mark">+</span>
            <Code s={s} lang={lang} />
          </div>
        ))}
      </div>
      <div className="border-t border-separator px-3 py-2 text-xs text-muted">
        {patch.note}
      </div>
    </Card>
  );
}
