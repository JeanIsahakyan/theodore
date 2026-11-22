/** Every page the site has: its path, what the tab and search engines read.
 *  The prerender script writes one HTML file per entry. */
export interface RouteMeta {
  path: string;
  title: string;
  description: string;
  /** Kept out of the sitemap and told to search engines: a page that is
   *  the same for every visitor and means nothing on its own. */
  noindex?: boolean;
}

export const SITE_URL = 'https://theodore.cloud';
export const SITE_NAME = 'Theodore';

export const ROUTES: RouteMeta[] = [
  {
    path: '/',
    title:
      'Theodore — your coding agents keep working after you leave the desk',
    description:
      'Theodore runs Claude Code, Codex and Gemini CLI on your computer, each change in its own space. When an agent needs you, your phone buzzes. Review by meaning and open the pull request from one window. Open source.',
  },
  {
    path: '/download',
    title: 'Download Theodore',
    description:
      'Theodore for macOS (Apple Silicon) and Linux (x86_64, arm64; AppImage or .deb). The phone app for iPhone and Android, and the web app.',
  },
  {
    path: '/releases',
    title: 'Changelog — Theodore',
    description:
      'Every Theodore release, newest first: what got faster, what got fixed, what to know.',
  },
  {
    path: '/privacy',
    title: 'Privacy policy — Theodore',
    description:
      'What stays on your computer, what the Theodore cloud sees, the optional desktop diagnostics, and how to delete your account.',
  },
  {
    path: '/terms',
    title: 'Terms of use — Theodore',
    description:
      'The terms for the open-source Theodore apps and the hosted Theodore cloud.',
  },
  {
    // One shell for every `/s/<id>` (public/_redirects rewrites them here).
    path: '/s',
    title: 'Open a space in Theodore',
    description:
      'A link to a Theodore space: opens it in the Theodore app on your computer or phone, or in the web app.',
    noindex: true,
  },
];

export const NOT_FOUND: RouteMeta = {
  path: '/404',
  title: 'Page not found — Theodore',
  description: 'This page does not exist.',
};

/** The route of a path: `/s/<anything>` is the space page. */
export function routeFor(path: string): RouteMeta {
  const clean = path.replace(/\/+$/, '') || '/';
  const exact = ROUTES.find((r) => r.path === clean);
  if (exact) return exact;
  if (clean.startsWith('/s/')) return ROUTES.find((r) => r.path === '/s')!;
  return NOT_FOUND;
}
