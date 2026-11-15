/**
 * Where a kit component renders. Inside a `Form` the native tree (SwiftUI
 * `Form` in a `Host`, a Compose column in a `Host`) is already there: a
 * control renders its bare native element as a row. Standalone it brings
 * its own `Host`.
 */
import { createContext, useContext } from 'react';

export const InForm = createContext(false);

export function useInForm(): boolean {
  return useContext(InForm);
}
