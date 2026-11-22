/**
 * File paths in an agent's reply (docs/mobile.md "Files"): inline code
 * like `src/app.tsx` or `.context/screen.png` becomes a tap that opens
 * the file viewer. Fleet text is untrusted, so only what plainly looks
 * like a relative path within the worktree qualifies; the host decides
 * the rest (`read_file`).
 *
 * ```text
 * `src/app.tsx`         ─▶ src/app.tsx          `README.md`      ─▶ README.md
 * `./docs/x.md:12`      ─▶ docs/x.md            `.context/a.png` ─▶ .context/a.png
 * `pnpm test`, `useState`, `foo()`, `/etc/passwd`, `https://x`, `a.b` ─▶ not a path
 * ```
 */

/** Extensions a bare file name (no `/`) is taken as a path with. */
export const FILE_EXTENSIONS = new Set([
  'md',
  'txt',
  'log',
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'env',
  'csv',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'rs',
  'py',
  'go',
  'swift',
  'kt',
  'kts',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'rb',
  'sh',
  'zsh',
  'bash',
  'sql',
  'css',
  'scss',
  'html',
  'xml',
  'svg',
  'plist',
  'lock',
  'dockerfile',
  'makefile',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'heic',
  'pdf',
  'mp4',
  'mov',
  'zip',
  'diff',
  'patch',
  'proto',
  'graphql',
  'tf',
  'gradle',
  'properties',
  'mdx',
]);

const SEGMENT = /^[A-Za-z0-9_.@+~-]+$/;
const LINE_SUFFIX = /(?::\d+){1,2}$/;

/**
 * The path a piece of inline code names, or `null`. Relative only, no
 * spaces, no shell or URL marks; a trailing `:line[:col]` is dropped.
 */
export function filePathOf(code: string): string | null {
  let s = code.trim();
  if (s === '' || s.length > 1024) return null;
  if (/[\s`"'<>|$(){}\[\]*?=;,!#%^&]/.test(s)) return null;
  if (s.includes('://') || s.startsWith('-')) return null;
  s = s.replace(LINE_SUFFIX, '');
  if (s.startsWith('./')) s = s.slice(2);
  if (s === '' || s.startsWith('/') || s.endsWith('/')) return null;
  const parts = s.split('/');
  if (parts.some((p) => p === '' || p === '..' || !SEGMENT.test(p)))
    return null;
  const last = parts[parts.length - 1]!;
  if (parts.length === 1) {
    // A bare name: only with a known extension (`useState` is a symbol,
    // `a.b` a property).
    const ext = extensionOf(last);
    return ext && FILE_EXTENSIONS.has(ext) ? s : null;
  }
  // With a directory: the last part has a dot, or lives in a known place.
  if (last.includes('.') && !last.endsWith('.')) return s;
  return parts[0] === '.context' ? s : null;
}

/** "png" of "a/b.PNG"; `null` without one. */
export function extensionOf(name: string): string | null {
  const base = name.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

export type FileKind = 'image' | 'pdf' | 'text' | 'other';

const IMAGE_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'heic',
  'heif',
  'bmp',
  'avif',
]);
const TEXT_EXT = new Set([
  'md',
  'mdx',
  'txt',
  'log',
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'env',
  'csv',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'rs',
  'py',
  'go',
  'swift',
  'kt',
  'kts',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'rb',
  'sh',
  'zsh',
  'bash',
  'sql',
  'css',
  'scss',
  'html',
  'xml',
  'svg',
  'plist',
  'lock',
  'diff',
  'patch',
  'proto',
  'graphql',
  'tf',
  'gradle',
  'properties',
  'dockerfile',
  'makefile',
  'gitignore',
]);

/** How the viewer shows a file: by its mime type, else its name. */
export function fileKind(name: string, mime: string | null = null): FileKind {
  const m = (mime ?? '').toLowerCase();
  if (/^image\/(png|jpeg|gif|webp|heic|heif|bmp|avif)$/.test(m)) return 'image';
  if (m === 'application/pdf') return 'pdf';
  if (
    m.startsWith('text/') ||
    /\b(json|xml|yaml|javascript|typescript)\b/.test(m)
  )
    return 'text';
  const ext = extensionOf(name) ?? name.toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'other';
}

/** The highlighter's language hint for a file name (`codeLanguage` maps it). */
export function languageHint(name: string): string | null {
  const base = (name.split('/').pop() ?? '').toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  return extensionOf(base);
}

/** The last path component. */
export const fileName = (path: string): string =>
  path.split('/').filter(Boolean).pop() ?? path;
