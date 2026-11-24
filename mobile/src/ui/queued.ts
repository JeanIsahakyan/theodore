/**
 * A message of yours waiting in the host's queue (docs/spaces.md §8), as
 * the bubble says it and acts on it (`SpaceChat.tsx` `QueuedRow`): plain
 * rules, no React.
 *
 * ```text
 * queued, waiting its turn ─▶ "Queued"
 * held by the host (its turn couldn't start, a usage limit left to you)
 *                          ─▶ "Held · hold to send or remove"
 * long press ─▶ Send now (runs it now, or back in line while a turn runs)
 *             · Remove (dropped from the queue)      both `queued_message`
 * ```
 */
import type { ChatMessage } from '../fleet/contract';
import type { MenuAction } from './messageMenu';

/** Over a queued bubble: waiting its turn, or held for your Send. */
export function queuedLabel(m: Pick<ChatMessage, 'queued'>): string {
  return m.queued?.held ? 'Held · hold to send or remove' : 'Queued';
}

export const QUEUED_HINT = 'Long-press for Send now and Remove';

/** A queued bubble's own long-press actions (`src/ui/messageMenu.ts`). */
export const SEND_NOW: MenuAction = { id: 'send_now', label: 'Send now' };
export const REMOVE: MenuAction = {
  id: 'remove',
  label: 'Remove',
  destructive: true,
};
export const QUEUED_ACTIONS: readonly MenuAction[] = [SEND_NOW, REMOVE];
