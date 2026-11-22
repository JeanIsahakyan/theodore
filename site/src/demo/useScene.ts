/**
 * A scene: a mock that plays its steps once it is scrolled into view, and
 * plays again when it comes back. The server, a reader without JavaScript
 * and a reader who prefers reduced motion get the final frame. The scene
 * pauses off screen and while the tab is hidden.
 *
 * `at[i]` is when step `i + 1` begins, in ms from the start; the value
 * returned is how many steps have begun (0 at the start, `at.length` at the
 * end). With `loop`, the scene starts over that many ms after the start.
 */
import { useEffect, useState, type RefObject } from 'react';

export function useScene(
  ref: RefObject<HTMLElement | null>,
  at: readonly number[],
  opts: { loop?: number; threshold?: number } = {},
): number {
  const final = at.length;
  const [step, setStep] = useState(final);
  useEffect(() => {
    const el = ref.current;
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let timers: number[] = [];
    let loop: number | undefined;
    let playing = false;
    let visible = false;
    const stop = () => {
      timers.forEach(clearTimeout);
      timers = [];
      if (loop !== undefined) clearInterval(loop);
      loop = undefined;
      playing = false;
    };
    const run = () => {
      setStep(0);
      timers.forEach(clearTimeout);
      timers = at.map((t, i) => window.setTimeout(() => setStep(i + 1), t));
    };
    const start = () => {
      stop();
      playing = true;
      run();
      if (opts.loop) loop = window.setInterval(run, opts.loop);
    };
    const sync = () => {
      if (visible && document.visibilityState === 'visible') {
        if (!playing) start();
      } else if (playing) {
        stop();
        setStep(final);
      }
    };
    const io = new IntersectionObserver(
      ([e]) => {
        visible = !!e?.isIntersecting;
        sync();
      },
      { threshold: opts.threshold ?? 0.35 },
    );
    io.observe(el);
    document.addEventListener('visibilitychange', sync);
    return () => {
      stop();
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
    // The timeline is static data; the ref is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);
  return step;
}
