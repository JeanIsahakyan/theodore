/**
 * The review screen: groups by meaning on the left (GroupsPane.tsx), the
 * diff with a finding on the right (DiffPane.tsx). A scene: the first group
 * ticks as read and the progress bar grows, the second becomes current and
 * opens its why and risk, then the finding slides in under its line.
 */
import { useRef } from 'react';
import { Chip } from '@heroui/react';
import { Check, TriangleExclamation } from '@gravity-ui/icons';
import { MockBtn, Window, WindowHeader } from '../components/Window';
import { Ring } from '../shared/Ring';
import { useScene } from '../demo/useScene';

const GROUPS = [
  {
    n: 1,
    title: 'Backoff policy for the export client',
    files: 2,
    add: 42,
    del: 6,
  },
  {
    n: 2,
    title: 'Retry loop in the job runner',
    files: 1,
    add: 31,
    del: 9,
    why: 'Uses the policy on every 429 and gives up after the budget.',
    risk: 'The attempt counter survives a success.',
  },
  {
    n: 3,
    title: 'Tests for retries',
    files: 2,
    add: 88,
    del: 0,
  },
];

type Tok = [cls: string, text: string];
const code = (...t: Tok[]) =>
  t.map(([c, s], i) => (
    <span key={i} className={c}>
      {s}
    </span>
  ));

const LINES: {
  t: 'ctx' | 'add' | 'del';
  o?: number;
  n?: number;
  src: Tok[];
}[] = [
  {
    t: 'ctx',
    o: 40,
    n: 40,
    src: [
      ['', '  '],
      ['tk-k', 'for'],
      ['', ' (;;) {'],
    ],
  },
  {
    t: 'del',
    o: 41,
    src: [
      ['', '    '],
      ['tk-k', 'const'],
      ['', ' res = '],
      ['tk-k', 'await'],
      ['', ' upload(batch);'],
    ],
  },
  {
    t: 'add',
    n: 41,
    src: [
      ['', '    '],
      ['tk-k', 'const'],
      ['', ' res = '],
      ['tk-k', 'await'],
      ['', ' upload(batch, { '],
      ['tk-t', 'signal'],
      ['', ' });'],
    ],
  },
  {
    t: 'add',
    n: 42,
    src: [
      ['', '    '],
      ['tk-k', 'if'],
      ['', ' (res.status !== '],
      ['tk-n', '429'],
      ['', ') '],
      ['tk-k', 'return'],
      ['', ' res;'],
    ],
  },
  {
    t: 'add',
    n: 43,
    src: [
      ['', '    attempt += '],
      ['tk-n', '1'],
      ['', ';'],
    ],
  },
  {
    t: 'add',
    n: 44,
    src: [
      ['', '    '],
      ['tk-k', 'if'],
      ['', ' (attempt > policy.max) '],
      ['tk-k', 'throw'],
      ['', ' '],
      ['tk-k', 'new'],
      ['', ' '],
      ['tk-t', 'RetryBudget'],
      ['', '();'],
    ],
  },
  {
    t: 'add',
    n: 45,
    src: [
      ['', '    '],
      ['tk-k', 'await'],
      ['', ' sleep(policy.delay(attempt));'],
    ],
  },
  { t: 'ctx', o: 42, n: 46, src: [['', '  }']] },
];

/** Step 1: group 1 read; 2: group 2 current; 3: the finding. */
const AT = [700, 1400, 2300];

export function ReviewMock() {
  const ref = useRef<HTMLDivElement>(null);
  const step = useScene(ref, AT);
  const stateOf = (n: number): 'done' | 'current' | 'todo' => {
    if (n === 1) return step >= 1 ? 'done' : 'current';
    if (n === 2) return step >= 2 ? 'current' : 'todo';
    return 'todo';
  };
  const read = step >= 1 ? 1 : 0;
  return (
    <div ref={ref}>
      <Window
        tab="#214 Retry the export job on 429s"
        tabIcon={
          <Ring color="var(--accent)" fill={0.4} title="Open, 40% read" />
        }
        label="The review screen: three groups by meaning on the left, one read; the diff of the current group on the right with a finding under a line"
        className="min-h-[440px]"
      >
        <WindowHeader
          title="#214 Retry the export job on 429s"
          chip="Checks running"
          right={
            <>
              <MockBtn tone="ghost" className="hidden sm:inline-flex">
                Checks
              </MockBtn>
              <MockBtn>Submit review</MockBtn>
              <MockBtn tone="primary">Merge</MockBtn>
            </>
          }
        />
        <div className="grid flex-1 grid-cols-1 md:grid-cols-[250px_minmax(0,1fr)]">
          <div className="groups flex flex-col border-b border-separator md:border-b-0 md:border-r">
            <div className="flex items-center gap-2 px-4 pt-4 text-xs text-muted">
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-default">
                <span
                  className="demo-bar block h-full w-full rounded-full bg-success"
                  style={{ transform: `scaleX(${read / 3})` }}
                />
              </span>
              <span className="tabular-nums">{read} of 3 groups read</span>
            </div>
            <ol className="flex flex-col gap-1 px-2 py-3">
              {GROUPS.map((g) => {
                const state = stateOf(g.n);
                return (
                  <li
                    key={g.n}
                    className={`grp flex items-start gap-3 rounded-2xl px-2 py-2 transition-colors duration-300 ${state === 'current' ? 'bg-default/60' : ''}`}
                  >
                    <span
                      className={`demo-pop grid size-[26px] shrink-0 place-items-center rounded-full border text-[11px] font-semibold tabular-nums ${
                        state === 'done'
                          ? 'border-success bg-success text-white'
                          : state === 'current'
                            ? 'border-accent text-accent'
                            : 'border-separator text-muted'
                      }`}
                      data-on={state === 'done'}
                    >
                      {state === 'done' ? <Check className="size-3.5" /> : g.n}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
                      <span
                        className={`text-[13px] ${state === 'current' ? 'font-semibold' : 'font-medium'}`}
                      >
                        {g.title}
                      </span>
                      <span className="flex items-center gap-2 text-xs text-muted tabular-nums">
                        {g.files} files
                        <span>
                          <span className="text-success">+{g.add}</span>{' '}
                          <span className="text-danger">−{g.del}</span>
                        </span>
                      </span>
                      {g.why && (
                        <span
                          className="demo-row"
                          data-on={state === 'current'}
                        >
                          <span className="mt-1 flex flex-col gap-1 text-xs text-muted">
                            <span>
                              <span className="font-medium text-foreground">
                                Why
                              </span>{' '}
                              {g.why}
                            </span>
                            <span className="flex items-start gap-1">
                              <TriangleExclamation className="mt-0.5 size-3 shrink-0 text-warning" />
                              {g.risk}
                            </span>
                          </span>
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
          <div className="flex min-w-0 flex-col">
            <div className="flex items-center gap-2 border-b border-separator px-4 py-2 text-xs">
              <span className="min-w-0 truncate font-mono">
                src/jobs/export.ts
              </span>
              <Chip size="sm" variant="secondary" className="shrink-0">
                also in 3
              </Chip>
              <span className="ms-auto shrink-0 text-muted">Viewed</span>
            </div>
            <div className="lines py-1">
              {LINES.map((l, i) => (
                <div key={i} className={`ln t-${l.t === 'ctx' ? 'none' : l.t}`}>
                  <span className="no">{l.o ?? ''}</span>
                  <span className="no">{l.n ?? ''}</span>
                  <span className="mark">
                    {l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''}
                  </span>
                  <span className="src">{code(...l.src)}</span>
                </div>
              ))}
            </div>
            <div className="demo-row mx-3 mb-3 mt-1" data-on={step >= 3}>
              <div className="flex flex-col gap-2 rounded-xl bg-surface px-3 py-2.5 text-xs shadow-card">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip size="sm" variant="soft" color="warning">
                    warn
                  </Chip>
                  <Chip size="sm" variant="secondary" className="font-mono">
                    bugs
                  </Chip>
                  <span className="font-medium">
                    The attempt counter never resets after a success
                  </span>
                </div>
                <p className="text-muted">
                  A batch that succeeds on the third try leaves{' '}
                  <code>attempt</code> at 2, so the next 429 is one step from
                  the budget.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <MockBtn>Draft comment</MockBtn>
                  <MockBtn>Make a task</MockBtn>
                  <MockBtn tone="ghost">Send to agent</MockBtn>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Window>
    </div>
  );
}
