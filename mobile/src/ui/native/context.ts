/**
 * Where a kit component renders. Inside a `Form` the native tree (SwiftUI
 * `Form` in a `Host`, a Compose column in a `Host`) is already there: a
 * control renders its bare native element as a row. Standalone it brings
 * its own `Host`. Inside another native tree that isn't a form (the
 * Material top app bar's actions) it renders bare, as a standalone control.
 */
import { createContext, useContext } from 'react';

export const InForm = createContext(false);

export function useInForm(): boolean {
  return useContext(InForm);
}

/** Already inside a `Host` (not a `Form`): no second `Host`. */
export const InHost = createContext(false);

export function useInHost(): boolean {
  return useContext(InHost);
}

/**
 * Inside a `Section`'s card (Android, web): a `Button` is a row there. A
 * `plain` section has none, and a `fullWidth` button stays a button.
 */
export const InCard = createContext(false);

export function useInCard(): boolean {
  return useContext(InCard);
}
