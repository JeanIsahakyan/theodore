import { describe, expect, it } from 'vitest';
import {
  TARGET_MAX,
  runningLine,
  summarizeTools,
  times,
  usedLine,
} from './toolSummary';

const calls = (tool: string, n: number) =>
  Array.from({ length: n }, () => [
    `tool: ${tool}`,
    'tool result ok=true',
  ]).flat();

describe('summarizeTools', () => {
  it('is empty for an empty log', () => {
    expect(summarizeTools([])).toEqual({
      steps: 0,
      groups: [],
      totals: [],
      latest: null,
    });
  });

  it('folds back-to-back calls of one tool into a single group', () => {
    const s = summarizeTools(calls('Bash', 12));
    expect(s.steps).toBe(12);
    expect(s.groups).toEqual([
      { kind: 'tool', tool: 'Bash', count: 12, target: null, failed: 0 },
    ]);
    expect(s.totals).toEqual([{ tool: 'Bash', count: 12 }]);
    expect(s.latest).toEqual({ tool: 'Bash', target: null });
  });

  it('keeps separate runs apart but totals them per tool, first-seen order', () => {
    const s = summarizeTools([
      ...calls('Read', 3),
      ...calls('Bash', 2),
      ...calls('Read', 4),
      ...calls('Edit', 1),
    ]);
    expect(
      s.groups.map((g) => (g.kind === 'tool' ? [g.tool, g.count] : g.text)),
    ).toEqual([
      ['Read', 3],
      ['Bash', 2],
      ['Read', 4],
      ['Edit', 1],
    ]);
    expect(s.totals).toEqual([
      { tool: 'Read', count: 7 },
      { tool: 'Bash', count: 2 },
      { tool: 'Edit', count: 1 },
    ]);
    expect(s.latest?.tool).toBe('Edit');
  });

  it('keeps the latest target of a group, truncated', () => {
    const long = `cargo test ${'x'.repeat(100)}`;
    const s = summarizeTools([
      'tool: Bash · npm ci',
      'tool: Bash · npm   test',
      'tool: Bash',
      `tool: Edit · ${long}`,
    ]);
    const [bash, edit] = s.groups;
    expect(bash).toMatchObject({ tool: 'Bash', count: 3, target: 'npm test' });
    expect(edit?.kind === 'tool' && edit.target?.length).toBe(TARGET_MAX);
    expect(edit?.kind === 'tool' && edit.target?.endsWith('…')).toBe(true);
    expect(s.latest?.tool).toBe('Edit');
  });

  it('counts a failed result against the call before it', () => {
    const s = summarizeTools([
      'tool: Bash',
      'tool result ok=false',
      'tool: Bash',
      'tool result ok=true',
    ]);
    expect(s.groups).toEqual([
      { kind: 'tool', tool: 'Bash', count: 2, target: null, failed: 1 },
    ]);
  });

  it('keeps other lines as notes, and a note breaks a run', () => {
    const s = summarizeTools(['tool: Bash', 'stalled', 'tool: Bash', '  ']);
    expect(s.steps).toBe(2);
    expect(s.groups).toEqual([
      { kind: 'tool', tool: 'Bash', count: 1, target: null, failed: 0 },
      { kind: 'note', text: 'stalled' },
      { kind: 'tool', tool: 'Bash', count: 1, target: null, failed: 0 },
    ]);
  });

  it("reads Theodore's own tools, whose labels have spaces", () => {
    const s = summarizeTools(['tool: read the PR', 'tool: run the check']);
    expect(s.totals.map((t) => t.tool)).toEqual([
      'read the PR',
      'run the check',
    ]);
  });
});

describe('lines', () => {
  it('writes ×N only past one call', () => {
    expect(times('Bash', 1)).toBe('Bash');
    expect(times('Bash', 12)).toBe('Bash ×12');
  });

  it('sums up a finished turn', () => {
    const s = summarizeTools([
      ...calls('Bash', 12),
      ...calls('Edit', 4),
      ...calls('Read', 7),
    ]);
    expect(usedLine(s)).toBe('Used Bash ×12, Edit ×4, Read ×7');
    expect(usedLine(s, 2)).toBe('Used Bash ×12, Edit ×4, +1 more');
    expect(usedLine(summarizeTools(['stalled']))).toBe('');
  });

  it('says what is running now', () => {
    expect(runningLine({ tool: 'Bash', target: 'npm test' })).toBe(
      'Running Bash · npm test…',
    );
    expect(runningLine({ tool: 'Read', target: null })).toBe('Running Read…');
    expect(runningLine({ tool: 'read the PR', target: null })).toBe(
      'Read the PR…',
    );
  });
});
