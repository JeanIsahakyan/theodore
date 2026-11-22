/**
 * What the visitor is on, from the browser, so the right download comes
 * first. Pure, testable; the browser bits are passed in.
 */
export type Platform =
  | 'mac-arm64'
  | 'mac-x64'
  | 'mac'
  | 'linux-x64'
  | 'linux-arm64'
  | 'linux'
  | 'ios'
  | 'android'
  | 'windows'
  | 'unknown';

export interface Hints {
  userAgent: string;
  /** `navigator.platform`, when the browser still has one. */
  platform?: string;
  /** From `navigator.userAgentData.getHighEntropyValues(['architecture'])`
   *  (Chromium) or a WebGL renderer naming Apple silicon. */
  arch?: 'arm' | 'x86' | null;
  /** iPadOS says it is a Mac; a touch screen tells it apart. */
  touchPoints?: number;
}

export function detectPlatform(h: Hints): Platform {
  const ua = h.userAgent;
  if (/iPhone|iPod/.test(ua) || (/iPad/.test(ua) && !/Windows/.test(ua)))
    return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) {
    if ((h.touchPoints ?? 0) > 1) return 'ios';
    if (h.arch === 'arm') return 'mac-arm64';
    if (h.arch === 'x86') return 'mac-x64';
    return 'mac';
  }
  if (/Linux|X11|CrOS/.test(ua)) {
    if (/aarch64|arm64|armv8/i.test(ua) || h.arch === 'arm')
      return 'linux-arm64';
    if (/x86_64|x64|amd64|i686/i.test(ua) || h.arch === 'x86')
      return 'linux-x64';
    return 'linux';
  }
  return 'unknown';
}

/** Apple silicon shows up as "Apple M1" / "Apple GPU" in the WebGL
 *  renderer; Intel Macs name an Intel or AMD GPU. */
export function archFromRenderer(renderer: string | null): Hints['arch'] {
  if (!renderer) return null;
  if (/Apple (M\d|GPU)/i.test(renderer)) return 'arm';
  if (/Intel|AMD|Radeon|NVIDIA/i.test(renderer)) return 'x86';
  return null;
}

/** Everything the browser can say, gathered in one place. */
export async function detectInBrowser(): Promise<Platform> {
  const nav = navigator as Navigator & {
    userAgentData?: {
      getHighEntropyValues: (
        hints: string[],
      ) => Promise<{ architecture?: string; platform?: string }>;
    };
  };
  let arch: Hints['arch'] = null;
  try {
    const hi = await nav.userAgentData?.getHighEntropyValues(['architecture']);
    if (hi?.architecture === 'arm') arch = 'arm';
    else if (hi?.architecture === 'x86') arch = 'x86';
  } catch {
    // not offered: fall back to WebGL below
  }
  if (!arch && /Macintosh/.test(nav.userAgent)) {
    try {
      const gl = document
        .createElement('canvas')
        .getContext('webgl') as WebGLRenderingContext | null;
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      const renderer = ext
        ? (gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string)
        : (gl?.getParameter(gl.RENDERER) as string | null);
      arch = archFromRenderer(renderer ?? null);
    } catch {
      // no WebGL: say "Mac" without the chip
    }
  }
  return detectPlatform({
    userAgent: nav.userAgent,
    platform: nav.platform,
    arch,
    touchPoints: nav.maxTouchPoints,
  });
}
