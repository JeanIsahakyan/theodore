/**
 * Which highlighter grammar a fenced block uses. Only the languages
 * registered in `code-block.tsx`, never a guess: a block with no language,
 * an unknown one, or too long to highlight on the phone is plain text.
 *
 * ```text
 * ```ts  ─▶ typescript      ```sh ─▶ bash      ```   ─▶ plain
 * ```kt  ─▶ kotlin          ```zz ─▶ plain     20 000+ chars ─▶ plain
 * ```
 */

export const HIGHLIGHT_MAX = 20_000;

export const LANGUAGES = [
  'bash',
  'c',
  'cpp',
  'css',
  'diff',
  'dockerfile',
  'go',
  'ini',
  'java',
  'javascript',
  'json',
  'kotlin',
  'makefile',
  'markdown',
  'python',
  'ruby',
  'rust',
  'sql',
  'swift',
  'typescript',
  'xml',
  'yaml',
] as const;

export type Language = (typeof LANGUAGES)[number];

const ALIASES: Record<string, Language> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  h: 'c',
  'c++': 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  patch: 'diff',
  docker: 'dockerfile',
  golang: 'go',
  toml: 'ini',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsonc: 'json',
  json5: 'json',
  kt: 'kotlin',
  kts: 'kotlin',
  make: 'makefile',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  html: 'xml',
  svg: 'xml',
  plist: 'xml',
  yml: 'yaml',
};

const KNOWN = new Set<string>(LANGUAGES);

export function codeLanguage(
  lang: string | null | undefined,
  code: string,
): Language | null {
  if (!lang || code.length > HIGHLIGHT_MAX) return null;
  const l = lang.trim().toLowerCase();
  if (KNOWN.has(l)) return l as Language;
  return ALIASES[l] ?? null;
}
