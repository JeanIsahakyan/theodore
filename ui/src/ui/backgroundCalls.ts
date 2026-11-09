import { createContext, useContext } from 'react';

/** The tool calls of the space's background tasks still running: a stored
 *  row reads "running in background" until its task ends. */
export const BackgroundCallsContext = createContext<ReadonlySet<string>>(
  new Set(),
);

/** Whether this call's background task is still running. */
export const useRunningBackgroundCall = (call?: string | null): boolean => {
  const calls = useContext(BackgroundCallsContext);
  return !!call && calls.has(call);
};
