import { useEffect, useState } from 'react';

/** Tracks an element's rendered width. No-op where `ResizeObserver`
 *  doesn't exist (tests): one read of `clientWidth` (or `innerWidth`, or
 *  `fallback` without a window), then it never updates. */
export function useElementWidth(
  ref: { current: HTMLElement | null },
  fallback: number,
): number {
  const [width, setWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : fallback,
  );
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w != null) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
