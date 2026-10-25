/** Colour literals in code: finding them in a line, parsing them to sRGB
 *  and formatting the values a preview shows. Pure and DOM-free; the
 *  swatch itself is rendered by `highlight.tsx`. */

/** An sRGB colour, channels and alpha in 0..1. `clipped` when the source
 *  (an oklch/oklab literal) lies outside sRGB and had to be clamped. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
  clipped: boolean;
}

/** A colour literal's character range within a line. */
export interface ColorHit {
  start: number;
  end: number;
  text: string;
}

const SCAN = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\([^()]*\)/gi;

/** Every colour literal in `line`, in order. `hashComments` is for
 *  languages where `#` opens a comment (Python, shell, YAML, …): there a
 *  `#` at the start or after whitespace is a comment, not a colour. A
 *  3/4-digit hex made of decimal digits only is read as an issue number
 *  (`#123`) unless all its digits are the same (`#333`). */
export function findColors(line: string, hashComments = false): ColorHit[] {
  // Cheap reject: most lines have neither.
  if (!line.includes('#') && !line.includes('(')) return [];
  const out: ColorHit[] = [];
  for (const m of line.matchAll(SCAN)) {
    const text = m[0];
    const start = m.index;
    if (text[0] === '#') {
      const prev = line[start - 1] ?? '';
      if (/[\w&#$]/.test(prev)) continue;
      if (hashComments && (prev === '' || /\s/.test(prev))) continue;
      const digits = text.slice(1);
      if (digits.length === 5 || digits.length === 7) continue;
      if (
        digits.length <= 4 &&
        /^\d+$/.test(digits) &&
        !/^(\d)\1*$/.test(digits)
      )
        continue;
    }
    if (!parseColor(text)) continue;
    out.push({ start, end: start + text.length, text });
  }
  return out;
}

const NUM = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg|rad|grad|turn)?$/i;

type Unit = '' | '%' | 'deg' | 'rad' | 'grad' | 'turn';

function num(tok: string): { v: number; u: Unit } | null {
  if (tok.toLowerCase() === 'none') return { v: 0, u: '' };
  const m = NUM.exec(tok);
  if (!m) return null;
  return { v: Number(m[1]), u: (m[2]?.toLowerCase() ?? '') as Unit };
}

const clamp = (x: number) => Math.min(1, Math.max(0, x));

/** A hue in degrees, from a bare number or an angle. */
function hue(t: { v: number; u: Unit }): number | null {
  const k = { '': 1, deg: 1, rad: 180 / Math.PI, grad: 0.9, turn: 360 }[
    t.u as Exclude<Unit, '%'>
  ];
  return k === undefined ? null : t.v * k;
}

/** A plain number, or a percentage of `pct` (what 100% means). */
function scalar(t: { v: number; u: Unit }, pct: number): number | null {
  if (t.u === '') return t.v;
  if (t.u === '%') return (t.v / 100) * pct;
  return null;
}

function hex(text: string): Rgba | null {
  let h = text.slice(1);
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) return null;
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const at = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return {
    r: at(0),
    g: at(2),
    b: at(4),
    a: h.length === 8 ? at(6) : 1,
    clipped: false,
  };
}

const toSrgb = (x: number) =>
  x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;

/** OKLab → sRGB (Björn Ottosson's matrices), clamped to the sRGB gamut. */
function oklabToRgb(L: number, a: number, b: number, alpha: number): Rgba {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(toSrgb);
  const clipped = lin.some((x) => x < -1e-4 || x > 1 + 1e-4);
  const [r, g, bl] = lin.map(clamp) as [number, number, number];
  return { r, g, b: bl, a: clamp(alpha), clipped };
}

function hslToRgb(h: number, s: number, l: number, alpha: number): Rgba {
  const k = (n: number) => (n + h / 30) % 12;
  const c = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - c * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0), g: f(8), b: f(4), a: clamp(alpha), clipped: false };
}

/** Parses one colour literal (`#rgb[a]`, `#rrggbb[aa]`, `rgb[a]()`,
 *  `hsl[a]()`, `oklch()`, `oklab()`; legacy comma or modern space syntax)
 *  to sRGB, or `null` when it isn't a colour — `rgb(r, g, b)` with
 *  variables, a nested `var()`, a stray unit. */
export function parseColor(text: string): Rgba | null {
  if (text[0] === '#') return hex(text);
  const m = /^(rgba?|hsla?|oklch|oklab)\(([^()]*)\)$/i.exec(text.trim());
  if (!m) return null;
  const fn = m[1]!.toLowerCase().replace(/a$/, '') as
    'rgb' | 'hsl' | 'oklch' | 'oklab';
  const body = m[2]!.trim();
  let parts: string[];
  let alphaTok: string | undefined;
  if (body.includes(',')) {
    if (fn !== 'rgb' && fn !== 'hsl') return null;
    parts = body.split(',').map((p) => p.trim());
    if (parts.length === 4) alphaTok = parts.pop();
  } else {
    const [main = '', a, ...rest] = body.split('/');
    if (rest.length) return null;
    parts = main.trim().split(/\s+/);
    alphaTok = a?.trim();
  }
  if (parts.length !== 3) return null;
  const [x, y, z] = parts.map(num);
  if (!x || !y || !z) return null;
  let alpha = 1;
  if (alphaTok !== undefined) {
    const at = num(alphaTok);
    const av = at && scalar(at, 1);
    if (av == null) return null;
    alpha = av;
  }
  if (fn === 'rgb') {
    const ch = [x, y, z].map((c) => scalar(c, 255));
    if (ch.some((c) => c == null)) return null;
    const [r, g, b] = (ch as number[]).map((c) => clamp(c / 255)) as [
      number,
      number,
      number,
    ];
    return { r, g, b, a: clamp(alpha), clipped: false };
  }
  if (fn === 'hsl') {
    const h = hue(x);
    const s = scalar(y, 100);
    const l = scalar(z, 100);
    if (h == null || s == null || l == null) return null;
    return hslToRgb(
      ((h % 360) + 360) % 360,
      clamp(s / 100),
      clamp(l / 100),
      alpha,
    );
  }
  const L = scalar(x, 1);
  if (L == null) return null;
  if (fn === 'oklch') {
    const C = scalar(y, 0.4);
    const h = hue(z);
    if (C == null || h == null) return null;
    const rad = (h * Math.PI) / 180;
    return oklabToRgb(L, C * Math.cos(rad), C * Math.sin(rad), alpha);
  }
  const a = scalar(y, 0.4);
  const b = scalar(z, 0.4);
  if (a == null || b == null) return null;
  return oklabToRgb(L, a, b, alpha);
}

const byte = (x: number) => Math.round(clamp(x) * 255);
const round = (x: number, d: number) => Number(x.toFixed(d));

/** The values a preview lists: hex (with alpha when translucent), and the
 *  same colour as `rgb()` and `hsl()`. */
export function formatColor(c: Rgba): {
  hex: string;
  rgb: string;
  hsl: string;
} {
  const [r, g, b] = [c.r, c.g, c.b].map(byte) as [number, number, number];
  const a = round(c.a, 3);
  const h2 = (n: number) => n.toString(16).padStart(2, '0');
  const hex = `#${h2(r)}${h2(g)}${h2(b)}${a < 1 ? h2(byte(a)) : ''}`;
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === c.r) h = ((c.g - c.b) / d) % 6;
    else if (max === c.g) h = (c.b - c.r) / d + 2;
    else h = (c.r - c.g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  const hsl = [
    Math.round(h),
    `${Math.round(s * 100)}%`,
    `${Math.round(l * 100)}%`,
  ];
  return {
    hex,
    rgb: a < 1 ? `rgba(${r}, ${g}, ${b}, ${a})` : `rgb(${r}, ${g}, ${b})`,
    hsl: a < 1 ? `hsla(${hsl.join(', ')}, ${a})` : `hsl(${hsl.join(', ')})`,
  };
}
