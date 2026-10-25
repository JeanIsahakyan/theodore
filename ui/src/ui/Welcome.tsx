import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { LogoArt, useLogoColors } from './Logo';

/** The whole welcome, start to finish: the logo holds for a beat, then
 *  zooms through while the app fades in (keyframes in styles.css). */
export const WELCOME_MS = 1650;

/** The app mark (`LogoArt`) cropped to the tile, in this build's colours,
 *  with the refraction stripes drifting. */
export const WelcomeLogo = observer(function WelcomeLogo({
  size,
  className = '',
  glint = false,
}: {
  size: number;
  className?: string;
  /** One soft band of light sweeps across the glass as it appears. */
  glint?: boolean;
}) {
  return (
    <LogoArt
      colors={useLogoColors()}
      size={size}
      viewBox="96 96 832 832"
      className={`welcome-logo ${className}`}
      animated
      glint={glint}
    />
  );
});

/** Motion is on, and something will actually run it: not with reduced
 *  motion, and not under jsdom (no Web Animations API), so tests never
 *  wait on the welcome. */
function canAnimate(): boolean {
  if (typeof matchMedia === 'undefined') return false;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return typeof document.documentElement.animate === 'function';
}

/** True for `WELCOME_MS` right after onboarding finishes in this window.
 *  An app that starts onboarded never plays it, so it's once per install
 *  (or per "Reset onboarding"). */
export function useWelcome(onboarded: boolean): boolean {
  const [was, setWas] = useState(onboarded);
  const [playing, setPlaying] = useState(false);
  // Set during render, not in an effect: the app's first frame already
  // has the logo over it, never a flash of the bare shell.
  if (was !== onboarded) {
    setWas(onboarded);
    setPlaying(onboarded && canAnimate());
  }
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setPlaying(false), WELCOME_MS);
    return () => clearTimeout(t);
  }, [playing]);
  return playing;
}

/** The logo alone on a blank page, then *whoosh*: it zooms through and
 *  the page clears to the app (which `.app-enter` brings in). Portalled
 *  out of the shell, so the shell's own fade-in doesn't fade it too. */
export function Welcome() {
  return createPortal(
    <div className="welcome fixed inset-0 z-[100] grid place-items-center bg-background">
      <div className="welcome-glow" aria-hidden />
      <WelcomeLogo size={168} glint className="welcome-zoom" />
    </div>,
    document.body,
  );
}
