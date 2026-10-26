import { useEffect, useRef, useState } from 'react';
import { api } from '../../core/api';
import { Code, langOf } from '../../highlight';
import { Shell } from '../bits';
import type { PrId, Sha } from '../../gen/contract';

type ViewerState =
  | { status: 'loading' }
  | { status: 'ready'; lines: string[] }
  | { status: 'missing' }
  | { status: 'error' };

/**
 * Read-only fallback for a symbol hit outside the open diff (plan
 * "symbols"): the file at the PR's head, fetched with the same `get_file`
 * command the diff itself uses for base-revision lookups — nothing new on
 * the core side, just a viewer that isn't a diff.
 */
export function SymbolViewer({
  pr,
  rev,
  path,
  line,
  onClose,
}: {
  pr: PrId;
  rev: Sha;
  path: string;
  line: number;
  onClose: () => void;
}) {
  const [state, setState] = useState<ViewerState>({ status: 'loading' });
  const targetRef = useRef<HTMLDivElement | null>(null);

  // `path` only ever changes by remounting (SymbolPeek renders one
  // viewer per hit), so `state` is still 'loading' — its initial value —
  // the first time this runs; no synchronous reset needed here.
  useEffect(() => {
    let live = true;
    api
      .getFile({ pr, rev, path })
      .then((text) => {
        if (!live) return;
        setState(
          text == null
            ? { status: 'missing' }
            : { status: 'ready', lines: text.split('\n') },
        );
      })
      .catch(() => live && setState({ status: 'error' }));
    return () => {
      live = false;
    };
  }, [pr, rev, path]);

  useEffect(() => {
    targetRef.current?.scrollIntoView({ block: 'center' });
  }, [state]);

  const lang = langOf(path);
  return (
    <Shell title={path} size="lg" onClose={onClose}>
      {state.status === 'loading' && (
        <div className="p-6 text-xs text-muted">Loading…</div>
      )}
      {state.status === 'missing' && (
        <div className="p-6 text-xs text-muted">
          {path} doesn't exist at this revision.
        </div>
      )}
      {state.status === 'error' && (
        <div className="p-6 text-xs text-muted">Couldn't load {path}.</div>
      )}
      {state.status === 'ready' && (
        <div className="lines max-h-[60vh] overflow-auto font-mono text-xs">
          {state.lines.map((s, i) => {
            const no = i + 1;
            return (
              <div
                key={no}
                ref={no === line ? targetRef : undefined}
                className={`ln ${no === line ? 'bg-accent/15' : ''}`}
                style={{ gridTemplateColumns: '44px minmax(0, 1fr)' }}
              >
                <span className="no">{no}</span>
                <Code s={s} lang={lang} />
              </div>
            );
          })}
        </div>
      )}
    </Shell>
  );
}
