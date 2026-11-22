/** Every page the site has: its path, what the tab and search engines read.
 *  The prerender script writes one HTML file per entry. */
export interface RouteMeta {
  path: string;
  title: string;
  description: string;
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
];

export const NOT_FOUND: RouteMeta = {
  path: '/404',
  title: 'Page not found — Theodore',
  description: 'This page does not exist.',
};

export function routeFor(path: string): RouteMeta {
  const clean = path.replace(/\/+$/, '') || '/';
  return ROUTES.find((r) => r.path === clean) ?? NOT_FOUND;
}
