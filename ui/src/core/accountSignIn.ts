/** Drives a Theodore account sign-in end to end (`account_sign_in_start`,
 *  then `account_sign_in_poll` until it settles) over the pure
 *  `reduceFlow` machine, so Settings and Onboarding share one flow. */
import { openExternal } from './openExternal';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { api, CommandFailure } from './api';
import {
  initialFlow,
  nextPollDelay,
  reduceFlow,
  type AccountFlow,
} from './accountFlow';
import type { AccountSignInMethod, AccountStatus } from '../gen/contract';

export interface AccountSignIn {
  flow: AccountFlow;
  start: (method: AccountSignInMethod, email?: string) => void;
  cancel: () => void;
  /** Re-opens the hosted page (the browser tab got closed). */
  reopen: () => void;
}

function message(e: unknown): string {
  return e instanceof CommandFailure ? e.message : String(e);
}

export function useAccountSignIn(
  onDone: (status: AccountStatus) => void,
): AccountSignIn {
  const [flow, dispatch] = useReducer(reduceFlow, initialFlow);
  const attemptRef = useRef(flow.attempt);
  useEffect(() => {
    attemptRef.current = flow.attempt;
  }, [flow.attempt]);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  // One timer per reply: every reply that keeps waiting bumps `polls`,
  // which arms the next one; a new attempt or interval re-arms it too.
  const delay = nextPollDelay(flow);
  const { attempt, polls } = flow;
  useEffect(() => {
    if (delay == null) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const state = await api.accountSignInPoll();
        if (cancelled) return;
        dispatch({ type: 'poll', attempt, state });
      } catch (e) {
        if (cancelled) return;
        dispatch({ type: 'failed', attempt, error: message(e) });
      }
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [delay, attempt, polls]);

  useEffect(() => {
    if (flow.phase !== 'done' || !flow.status) return;
    if (flow.method === 'browser') void api.focusWindow();
    onDoneRef.current(flow.status);
  }, [flow.phase, flow.status, flow.method]);

  const start = useCallback((method: AccountSignInMethod, email?: string) => {
    const next = attemptRef.current + 1;
    dispatch({ type: 'start', method });
    void api
      .accountSignInStart({ method, email: email?.trim() || null })
      .then((s) => {
        dispatch({ type: 'started', attempt: next, start: s });
        if (s.method === 'browser') openExternal(s.url);
      })
      .catch((e) =>
        dispatch({ type: 'failed', attempt: next, error: message(e) }),
      );
  }, []);

  const cancel = useCallback(() => {
    dispatch({ type: 'cancel' });
    void api.accountSignInCancel().catch(() => {});
  }, []);

  const reopen = useCallback(() => {
    if (flow.url) openExternal(flow.url);
  }, [flow.url]);

  return { flow, start, cancel, reopen };
}
