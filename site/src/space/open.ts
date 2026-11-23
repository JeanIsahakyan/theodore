/**
 * The `/s/<id>` page's logic (docs/website.md "Space links"): what a
 * visitor's browser should try and which buttons it gets. Pure, so the
 * tests read it; the page feeds it the path, the platform and the host.
 *
 * ```text
 * https://theodore.cloud/s/<id>
 *   iPhone / Android, app installed ─▶ Universal Link / App Link: the app, this page never shows
 *   iPhone / Android, no app        ─▶ Open in Theodore Code (theodore-mobile://) · web app · Get the app
 *   macOS / Linux                   ─▶ theodore://space/<id> tried at once; ~1.5 s later, still here:
 *                                      Open in Theodore · Open in the web app · Download Theodore
 *   anything else                   ─▶ Open in the web app · Download Theodore
 * https://staging.theodore.cloud/s/<id> ─▶ the same, on theodore-staging:// and app-staging
 * ```
 *
 * The page knows the id and nothing else: it fetches nothing and shows no
 * space data. Only a device signed in to the space's organization and
 * trusted by the computer that runs it can open it.
 */
import type { Platform } from '../download/platform';

/** A space id as the desktop makes them (`deep_link::space_route`): up to
 *  64 of `[A-Za-z0-9_-]`. Anything else isn't a space link. */
const SPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `/s/<id>` ─▶ `<id>`; `null` for any other path or a bad id. */
export function spaceIdFromPath(path: string): string | null {
  const m = /^\/s\/([^/?#]+)\/?$/.exec(path);
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1] ?? '');
  } catch {
    return null;
  }
  return SPACE_ID.test(id) ? id : null;
}

export interface Channel {
  /** The desktop's URL scheme on this channel (`identity::url_scheme`). */
  scheme: 'theodore' | 'theodore-staging';
  /** The phone app's scheme (mobile/app.json). One app for every channel. */
  mobileScheme: 'theodore-mobile';
  /** The web app (docs/cloud.md "Hosts on theodore.cloud"). */
  webApp: string;
}

const PRODUCTION: Channel = {
  scheme: 'theodore',
  mobileScheme: 'theodore-mobile',
  webApp: 'https://app.theodore.cloud',
};

const STAGING: Channel = {
  scheme: 'theodore-staging',
  mobileScheme: 'theodore-mobile',
  webApp: 'https://app-staging.theodore.cloud',
};

/** The channel a host serves: theodore.cloud (and www) is production;
 *  staging.theodore.cloud, Pages previews and a local dev server are
 *  staging, whose desktop registers `theodore-staging://`. */
export function channelFor(hostname: string): Channel {
  const h = hostname.toLowerCase();
  return h === 'theodore.cloud' || h === 'www.theodore.cloud'
    ? PRODUCTION
    : STAGING;
}

export type Target = 'phone' | 'desktop' | 'other';

export function targetFor(platform: Platform): Target {
  switch (platform) {
    case 'ios':
    case 'android':
      return 'phone';
    case 'mac':
    case 'mac-arm64':
    case 'mac-x64':
    case 'linux':
    case 'linux-x64':
    case 'linux-arm64':
      return 'desktop';
    default:
      return 'other';
  }
}

export interface OpenButton {
  label: string;
  href: string;
  tone: 'primary' | 'secondary';
}

export interface OpenPlan {
  target: Target;
  /** Tried as soon as the page runs (the desktop's scheme), or nothing. */
  autoOpen: string | null;
  buttons: OpenButton[];
}

export const DOWNLOAD = '/download';

/** The desktop link, the web app's page for the space, the phone's link. */
export function links(id: string, channel: Channel) {
  const space = encodeURIComponent(id);
  return {
    desktop: `${channel.scheme}://space/${space}`,
    phone: `${channel.mobileScheme}://space/${space}`,
    webApp: `${channel.webApp}/space/${space}`,
  };
}

export function planFor(
  id: string,
  platform: Platform,
  channel: Channel,
): OpenPlan {
  const target = targetFor(platform);
  const l = links(id, channel);
  switch (target) {
    case 'desktop':
      return {
        target,
        autoOpen: l.desktop,
        buttons: [
          { label: 'Open in Theodore', href: l.desktop, tone: 'primary' },
          { label: 'Open in the web app', href: l.webApp, tone: 'secondary' },
          { label: 'Download Theodore', href: DOWNLOAD, tone: 'secondary' },
        ],
      };
    case 'phone':
      // The app, when installed, took the link before this page loaded
      // (Universal Links / App Links). Here: not installed, or opened in
      // the browser on purpose.
      return {
        target,
        autoOpen: null,
        buttons: [
          { label: 'Open in Theodore Code', href: l.phone, tone: 'primary' },
          { label: 'Open in the web app', href: l.webApp, tone: 'secondary' },
          { label: 'Get the app', href: DOWNLOAD, tone: 'secondary' },
        ],
      };
    default:
      return {
        target,
        autoOpen: null,
        buttons: [
          { label: 'Open in the web app', href: l.webApp, tone: 'primary' },
          { label: 'Download Theodore', href: DOWNLOAD, tone: 'secondary' },
        ],
      };
  }
}

/** How long the desktop's scheme gets before the buttons show. */
export const SHOW_BUTTONS_AFTER_MS = 1500;
