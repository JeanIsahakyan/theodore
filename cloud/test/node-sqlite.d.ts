// The slice of node:sqlite (Node ≥ 22.13) the fleet tests use, so the
// package needs no @types/node.
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    prepare(sql: string): {
      all(...params: unknown[]): Record<string, unknown>[];
    };
  }
}
