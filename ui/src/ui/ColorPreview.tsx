/**
 * The bigger preview for a colour swatch in code (see `Swatch` in
 * `highlight.tsx`): one host for the whole app, driven by a single delegated
 * `pointerover` on the document — a diff with thousands of swatches carries
 * no per-swatch handlers or state. The swatch's own `data-color` is the
 * literal; it's re-parsed here on hover, which is cheap.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { formatColor, parseColor } from '../colors';

interface Hover {
  color: string;
  rect: DOMRect;
}

const WIDTH = 220;

export function ColorPreviewHost() {
  const [hover, setHover] = useState<Hover | null>(null);
  useEffect(() => {
    // The swatch shown, if any: moving between other elements is a no-op.
    let shown: Element | null = null;
    const over = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      const color = el?.classList.contains('cswatch')
        ? el.getAttribute('data-color')
        : null;
      const next = el && color ? el : null;
      if (next === shown) return;
      shown = next;
      setHover(
        next && color ? { color, rect: next.getBoundingClientRect() } : null,
      );
    };
    // Its anchor moved: a stale preview is worse than none.
    const hide = () => {
      if (!shown) return;
      shown = null;
      setHover(null);
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('scroll', hide, true);
    document.addEventListener('pointerdown', hide);
    return () => {
      document.removeEventListener('pointerover', over);
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('pointerdown', hide);
    };
  }, []);

  const c = hover && parseColor(hover.color);
  if (!hover || !c) return null;
  const f = formatColor(c);
  const values = [f.hex, f.rgb, f.hsl].filter(
    (v) => v.toLowerCase() !== hover.color.toLowerCase(),
  );
  // Above the swatch, or below when it's near the top; kept on screen.
  const below = hover.rect.top < 140;
  const left = Math.max(
    8,
    Math.min(hover.rect.left - 8, window.innerWidth - WIDTH - 8),
  );
  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 flex items-center gap-3 rounded-xl border border-separator bg-overlay p-2 font-mono text-xs text-overlay-foreground shadow-overlay"
      style={{
        left,
        width: WIDTH,
        ...(below
          ? { top: hover.rect.bottom + 6 }
          : { top: hover.rect.top - 6, transform: 'translateY(-100%)' }),
      }}
    >
      <span
        className="cswatch cswatch-lg"
        style={{ '--sw': hover.color } as CSSProperties}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate">{hover.color}</span>
        {values.map((v) => (
          <span key={v} className="truncate text-muted">
            {v}
          </span>
        ))}
        {c.clipped && (
          <span className="font-sans text-muted">
            outside sRGB · values clipped
          </span>
        )}
      </div>
    </div>,
    document.body,
  );
}
