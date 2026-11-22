/**
 * The hero's story, as a list of moments: an agent works on the computer,
 * asks a question, the phone gets it, one tap answers, the agent goes on and
 * opens a pull request. Pure data, so the component only keeps an index.
 */
export const PHASES = [
  'start',
  'read1',
  'read2',
  'edit1',
  'ask',
  'notify',
  'tap',
  'sent',
  'answered',
  'edit2',
  'test',
  'pr',
] as const;

export type Phase = (typeof PHASES)[number];

/** When each phase begins, in ms from the start of a loop. */
export const AT: Record<Phase, number> = {
  start: 0,
  read1: 900,
  read2: 1700,
  edit1: 2600,
  ask: 3600,
  notify: 4400,
  tap: 6300,
  sent: 7000,
  answered: 7600,
  edit2: 8500,
  test: 9500,
  pr: 10500,
};

/** How long a loop lasts before it starts over. */
export const LOOP_MS = 15000;

export const FINAL: Phase = 'pr';

/** Whether `phase` has been reached at `current`. */
export function reached(current: Phase, phase: Phase): boolean {
  return PHASES.indexOf(current) >= PHASES.indexOf(phase);
}

/** The one line under the window, per phase. */
export function statusOf(current: Phase): {
  kind: 'working' | 'waiting' | 'done';
  text: string;
} {
  if (reached(current, 'pr'))
    return { kind: 'done', text: 'Done · pull request #482 opened' };
  if (reached(current, 'answered'))
    return { kind: 'working', text: 'Working · 3:10' };
  if (reached(current, 'ask'))
    return { kind: 'waiting', text: 'Waiting for your answer' };
  return { kind: 'working', text: 'Working · 0:42' };
}
