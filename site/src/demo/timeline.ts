/**
 * The hero's story, as a list of moments: an agent works on the computer,
 * asks a question, the phone gets it, one tap answers, the agent goes on,
 * the tests pass and it opens a pull request. Pure data, so the component
 * only keeps an index.
 *
 * The loop starts at the key frame (the question on the computer, the push
 * on the phone): that is what the server renders, what a link preview shows
 * and what reduced motion keeps. From there the story plays to the PR,
 * holds, starts over from an empty chat and comes back to the key frame.
 */
export const STORY = [
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
  'pass',
  'pr',
] as const;

export type Phase = (typeof STORY)[number];

/** The still frame. */
export const KEY: Phase = 'notify';

/** One loop, from the key frame: when each phase begins, in ms. Holds on
 *  the key moments: the push (2.2 s), the opened PR (3 s). */
export const LOOP: readonly (readonly [Phase, number])[] = [
  ['notify', 0],
  ['tap', 2200],
  ['sent', 2700],
  ['answered', 3400],
  ['edit2', 4100],
  ['test', 4800],
  ['pass', 5700],
  ['pr', 6400],
  ['start', 9400],
  ['read1', 10000],
  ['read2', 10600],
  ['edit1', 11200],
  ['ask', 11900],
];

/** How long a loop lasts before the key frame comes back. */
export const LOOP_MS = 13000;

/** Whether `phase` has been reached at `current`, in story order. */
export function reached(current: Phase, phase: Phase): boolean {
  return STORY.indexOf(current) >= STORY.indexOf(phase);
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
