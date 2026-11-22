/**
 * Redaction, applied to every record before any sink, the ring included
 * (docs/telemetry.md "Redaction"; the desktop's `crates/telemetry/src/redact.rs`).
 *
 * ```text
 * local  secrets in any text ─▶ [redacted]      emails ─▶ <email:hash>
 *        credential fields  ─▶ [redacted]       content fields ─▶ [omitted: N bytes]
 *        long values cut (2 KB; messages 4 KB; stacks 8 KB)
 * remote the local rules, then fields naming a project, space, device, host,
 *        branch, path, URL, login, user or account ─▶ h:<hash>
 *        (hashed with a key unique to this install; ids like `dev_…`,
 *        `rs_…`, `req_…` and `user_…` stay as they are)
 * ```
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8 } from '../keys/base64';
import type { Fields, FieldValue, TelemetryRecord } from './types';

export const FIELD_MAX = 2 * 1024;
export const MSG_MAX = 4 * 1024;
export const STACK_MAX = 8 * 1024;

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** 16 hex of SHA-256(key ‖ value): the same value hashes the same on one
 *  install, and nothing links two installs. */
export function hashWith(key: string, value: string): string {
  return hex(sha256(utf8(`${key}\u0000${value}`)).slice(0, 8));
}

// ── secrets in any text ─────────────────────────────────────────────────────

const SECRETS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgl[a-z]{2,6}-[A-Za-z0-9_-]{16,}\b/g,
  /\bAT(?:BB|ATT)[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bphc_[A-Za-z0-9]{20,}\b/g,
  /\bExponentPushToken\[[^\]]*\]/g,
  /\bExpoPushToken\[[^\]]*\]/g,
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\b(?:authorization|cookie|private-token|x-api-key)\s*[:=]\s*[^\s,;]+/gi,
  // Passwords in URLs.
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(?=@)/gi,
  // Sensitive query parameters.
  /([?&](?:code|state|token|key|api_key|access_token|refresh_token|secret|password|verifier|code_verifier)=)[^&\s#]+/gi,
  // `token=`, `"secret": "…"`, `password: …` pairs.
  /\b(token|secret|password|passwd|api_key|apikey|access_token|refresh_token|client_secret|code_verifier)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
  // Env-style assignments.
  /\b([A-Z0-9_]*(?:KEY|TOKEN|PAT|PASS|PASSWORD|SECRET|AUTH|DSN)=)[^\s]+/g,
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Secrets and emails taken out of free text. */
export function redactText(text: string, key: string): string {
  let out = text;
  for (const re of SECRETS) {
    out = out.replace(re, (...args: unknown[]) => {
      // (match, ...groups, offset, string[, namedGroups]): the kept prefix
      // groups come first; patterns without groups keep nothing.
      const named = typeof args[args.length - 1] === 'object' ? 1 : 0;
      const groups = args.slice(1, args.length - 2 - named);
      const kept = groups.filter((g): g is string => typeof g === 'string');
      return `${kept.join('')}[redacted]`;
    });
  }
  out = out.replace(EMAIL, (m, offset: number) => {
    // `git@host:…` remotes are kept.
    if (m.startsWith('git@') && out[offset + m.length] === ':') return m;
    return `<email:${hashWith(key, m.toLowerCase())}>`;
  });
  return out;
}

// ── field rules ─────────────────────────────────────────────────────────────

const segments = (name: string): string[] =>
  name.toLowerCase().split(/[._-]/).filter(Boolean);

const CREDENTIAL = new Set([
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwd',
  'authorization',
  'cookie',
  'verifier',
  'api',
  'apikey',
  'credential',
  'credentials',
  'jwt',
  'bearer',
  'key',
]);

/** A field whose value is a credential by its name. */
export function isCredentialField(name: string): boolean {
  const segs = segments(name);
  if (segs.includes('api') && segs.includes('key')) return true;
  if (segs.includes('code') && segs.includes('verifier')) return true;
  return segs.some((s) => CREDENTIAL.has(s) && s !== 'api' && s !== 'key');
}

const CONTENT = new Set([
  'text',
  'goal',
  'message',
  'messages',
  'body',
  'comment',
  'comments',
  'content',
  'contents',
  'prompt',
  'markdown',
  'snippet',
  'blob',
  'title',
  'description',
  'reply',
  'suggestion',
  'stdout',
  'stderr',
  'transcript',
  'diff',
  'hunk',
  'hunks',
  'patch',
  'answer',
  'answers',
  'question',
  'questions',
  'options',
  'live',
  'label',
  'note',
  'email',
  'name',
  'user_name',
  'full_name',
  'display_name',
]);

/** A field whose value is someone's words or content: never kept. */
export function isContentField(name: string): boolean {
  const segs = segments(name);
  const last = segs[segs.length - 1] ?? '';
  if (CONTENT.has(name.toLowerCase())) return true;
  // `*_text`, `*_body`, `last_reply`…; but `host_name`, `project_name`,
  // `device_name` are names (hashed remotely), not content.
  if (last === 'name') return segs.length === 1 || segs.includes('user');
  return CONTENT.has(last) && last !== 'name';
}

const NAMED = new Set([
  'repo',
  'repository',
  'pr',
  'branch',
  'project',
  'space',
  'path',
  'url',
  'href',
  'login',
  'user',
  'account',
  'host',
  'device',
  'org',
  'organization',
  'name',
  'file',
  'dir',
  'directory',
]);

/** A remote-only rule: a field naming a repo, project, space, device,
 *  host, path, URL, login, user or account is hashed. Ids are kept. */
export function isNamedField(name: string): boolean {
  const segs = segments(name);
  if (segs[segs.length - 1] === 'id') return false;
  if (segs[segs.length - 1] === 'kind' || segs[segs.length - 1] === 'code')
    return false;
  if (segs.includes('count') || segs.includes('ms')) return false;
  return segs.some((s) => NAMED.has(s));
}

const PATHS = new Set(['path', 'file', 'dir', 'directory', 'url', 'href']);

/** Values the desktop keeps as they are: our own opaque ids. */
const OPAQUE_ID =
  /^(?:dev|rs|req|user|org|ask|conf|cmd|run|send|pending|op)_[A-Za-z0-9_-]{4,}$/;

const bytesOf = (s: string): number => utf8(s).length;

function cut(value: string, max: number, tail: boolean): string {
  if (value.length <= max) return value;
  const over = value.length - max;
  return tail
    ? `…[truncated ${over} bytes]${value.slice(-max)}`
    : `${value.slice(0, max)}…[truncated ${over} bytes]`;
}

export interface RedactOptions {
  /** The per-install hashing key. */
  key: string;
  /** Hash names and paths too (anything that leaves the device). */
  remote: boolean;
}

function redactValue(
  name: string,
  value: FieldValue,
  o: RedactOptions,
): FieldValue {
  if (typeof value !== 'string') return value;
  if (isCredentialField(name)) return '[redacted]';
  if (isContentField(name)) return `[omitted: ${bytesOf(value)} bytes]`;
  if (o.remote && isNamedField(name)) {
    if (value === '') return '';
    if (OPAQUE_ID.test(value)) return value;
    const url = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+)(.*)$/i.exec(value);
    if (url) return `${url[1]}/<url:${hashWith(o.key, url[2] ?? '')}>`;
    const segs = segments(name);
    const pathy = segs.some((s) => PATHS.has(s));
    if (pathy || /^(?:~|\.{1,2})?[\\/]/.test(value))
      return `<path:${hashWith(o.key, value)}>`;
    return `h:${hashWith(o.key, value)}`;
  }
  const segs = segments(name);
  const stack = segs.includes('stack') || segs.includes('backtrace');
  const max = stack ? STACK_MAX : FIELD_MAX;
  const tail = segs[segs.length - 1] === 'tail';
  return cut(redactText(value.replace(/\/Users\/[^/\s]+/g, '~'), o.key), max, tail);
}

export function redactFields(fields: Fields, o: RedactOptions): Fields {
  const out: Fields = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[name] = redactValue(name, value, o);
  }
  return out;
}

/** The record as a sink may see it. */
export function redactRecord(
  r: TelemetryRecord,
  o: RedactOptions,
): TelemetryRecord {
  return {
    ...r,
    msg: cut(redactText(r.msg, o.key), MSG_MAX, false),
    fields: redactFields(r.fields, o),
  };
}

/** Anything thrown, as fields: its message (redacted later) and stack. */
export function errorFields(e: unknown): Fields {
  if (e instanceof Error) {
    const out: Fields = { error: e.message, error_name: e.name };
    if (typeof e.stack === 'string') out.stack = e.stack;
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') out['error.code'] = code;
    return out;
  }
  return { error: typeof e === 'string' ? e : String(e) };
}
