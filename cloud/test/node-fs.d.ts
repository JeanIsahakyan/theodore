// The slice of node:fs the push contract test uses (no @types/node).
declare module 'node:fs' {
  export function readFileSync(path: URL, encoding: 'utf8'): string;
}
