/**
 * What the page is rendered with: the release baked in at build time (the
 * prerender script's fetch), carried to the browser as JSON, and refreshed
 * there. Both renders start from the same value, so hydration matches.
 */
import { createContext, useContext } from 'react';
import type { Release } from '../download/release';

export interface PageData {
  release: Release | null;
  /** For the footer; fixed at build so the server and client agree. */
  year: number;
}

export const PageDataContext = createContext<PageData>({
  release: null,
  year: 2026,
});

export function usePageData(): PageData {
  return useContext(PageDataContext);
}

declare global {
  interface Window {
    __THEODORE_DATA__?: PageData;
  }
}
