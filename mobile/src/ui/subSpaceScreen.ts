/**
 * The sub-space screen's words (docs/mobile.md "Sub-spaces"), without React:
 * the line under its title, how a read message is drawn, the question card's
 * view, what an error line says.
 *
 * ```text
 * Fix the flaky test
 * sub-space of Retry on 429 · on mac-A · Waiting for you
 * ```
 */
import type {
  QuestionView,
  SubSpaceMessage,
  SubSpaceRead,
} from '../fleet/types';
import { SUB_STATE_LABEL, subSpaceState } from './subSpaceTree';

/** "sub-space of <parent> · on <host> · <state>". */
export function subSpaceSubtitle(input: {
  parentTitle: string;
  hostName: string;
  status: string;
  done: boolean;
}): string {
  const state = SUB_STATE_LABEL[subSpaceState(input)];
  return [
    input.parentTitle ? `sub-space of ${input.parentTitle}` : 'sub-space',
    `on ${input.hostName}`,
    state,
  ].join(' · ');
}

/** Whose message: yours (or its parent agent's) as a bubble, the agent's
 *  full width. */
export const messageSide = (
  m: Pick<SubSpaceMessage, 'from'>,
): 'user' | 'assistant' =>
  m.from === 'user' || m.from.startsWith('space:') ? 'user' : 'assistant';

/** A small muted line over a message from another space's agent. */
export function messageFrom(m: Pick<SubSpaceMessage, 'from'>): string | null {
  return m.from.startsWith('space:') ? 'From its parent space' : null;
}

/** A stable key per message (the host sends none). */
export const messageKey = (m: SubSpaceMessage, i: number): string =>
  `${i}:${m.at}:${m.from}`;

/** The read's question as the card takes it; `null` without one. */
export function subSpaceQuestion(
  read: Pick<SubSpaceRead, 'space' | 'question'>,
): QuestionView | null {
  if (!read.question) return null;
  return {
    askId: read.question.ask,
    space: read.space,
    from: '',
    questions: read.question.questions,
  };
}

/** The sub-space takes a message: not while it fails to exist or is gone. */
export const subSpaceSendable = (status: string): boolean =>
  status !== 'archived' && status !== 'unknown';

/** "Can't reach mac-A" for a host offline, else the refusal as `errorText`
 *  says it. */
export function readErrorText(hostName: string, text: string): string {
  return /fleet\.offline|not connected|in time/.test(text)
    ? `Can't reach ${hostName}`
    : text;
}
