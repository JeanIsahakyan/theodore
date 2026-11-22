/**
 * What the page is rendered with: the release, the GitHub stars and (on
 * /releases) every release's notes, baked in at build time (the prerender
 * script's fetches), carried to the browser as JSON, and refreshed there.
 * Both renders start from the same value, so hydration matches.
 */
import { createContext, useContext } from 'react';
import type { Release } from '../download/release';
import type { ReleaseNote } from '../releases/notes';

export interface PageData {
  release: Release | null;
  /** Stargazers of the repository; null when the build couldn't ask. */
  stars: number | null;
  /** Every release, newest first. Baked only into /releases; other pages
   *  fetch /releases.json when they navigate there. */
  releases?: ReleaseNote[];
  /** For the footer; fixed at build so the server and client agree. */
  year: number;
}

export const PageDataContext = createContext<PageData>({
  release: null,
  stars: null,
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
