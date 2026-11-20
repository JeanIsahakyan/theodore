/**
 * A JSON answer read field by field in assertions: any key or index gives
 * another `Loose`, compared with `expect`. Not `any`: nothing is assumed
 * about the leaves. The keys tests walk through are spelled out, so
 * `noUncheckedIndexedAccess` doesn't make every step optional.
 */
type Walked =
  | 'result'
  | 'error'
  | 'data'
  | 'device'
  | 'lines'
  | 'content'
  | 'capabilities'
  | 'serverInfo'
  | 'tools'
  | 'spaces';

export type Loose = { readonly [K in Walked]: Loose } & {
  readonly [k: string]: Loose;
} & {
  readonly 0: Loose;
  readonly length: number;
  map<T>(f: (x: Loose) => T): T[];
};
