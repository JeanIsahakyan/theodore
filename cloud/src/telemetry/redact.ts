/**
 * Redaction for the cloud's logs, a port of the app's rules
 * (docs/telemetry.md "Redaction") to what the Worker handles: applied to
 * every record before any sink, Workers Logs included, and to what the
 * telemetry relay forwards for the phone app.
 *
 * ```text
 * attrs ─▶ credential field (token, secret, signature, …) ─▶ [redacted]
 *       ─▶ content field (body, text, goal, envelope, name, …) ─▶ [omitted: N bytes]
 *       ─▶ any string ─▶ secrets ─▶ [redacted]; emails ─▶ <email:hash>; ≤ 2 KB
 *       ─▶ object ─▶ JSON, then as a string
 * remote only ─▶ user / org / account fields ─▶ h:<hash>
 * ```
 */

/** A value OTLP and Workers Logs take as is. */
export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue>;

/** Strings over this are cut; stacks get four times as much. */
export const MAX_TEXT = 2 * 1024;
export const MAX_STACK = 8 * 1024;

/** A field named (or segmented) so is a credential, whatever it holds. */
const CREDENTIAL_SEGMENTS = new Set([
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwd',
  'authorization',
  'cookie',
  'cookies',
  'nonce',
  'signature',
  'apikey',
  'api_key',
  'credential',
  'credentials',
  'refresh_token',
  'access_token',
  'code_verifier',
]);

/** A field that carries what a person wrote or a device sent: never kept. */
const CONTENT_SEGMENTS = new Set([
  'body',
  'text',
  'message',
  'messages',
  'goal',
  'envelope',
  'question',
  'questions',
  'answer',
  'answers',
  'title',
  'description',
  'prompt',
  'reply',
  'content',
  'contents',
  'data',
  'info',
  'name',
  'email',
  'options',
  'stdout',
  'stderr',
  'diff',
  'patch',
]);

/** Fields naming a person or an account: hashed in remote records. */
const IDENTITY_SEGMENTS = new Set(['user', 'account', 'org', 'organization']);

/** Fields that are not credentials even though they end in `key`. */
const PUBLIC_KEYS = new Set(['public_key', 'target_key', 'kid']);

const segments = (name: string) =>
  name
    .toLowerCase()
    .split(/[._\-/]+/)
    .filter(Boolean);

export function isCredentialField(name: string): boolean {
  if (PUBLIC_KEYS.has(name)) return false;
  const parts = segments(name);
  return (
    parts.some((p) => CREDENTIAL_SEGMENTS.has(p)) ||
    parts.includes('key') ||
    parts.includes('pat') ||
    parts.includes('jwt')
  );
}

/** Content fields whose text is still wanted (redacted and cut, not omitted). */
const KEPT_TEXT = new Set(['error.message', 'error.kind']);

export function isContentField(name: string): boolean {
  if (KEPT_TEXT.has(name)) return false;
  return segments(name).some((p) => CONTENT_SEGMENTS.has(p));
}

/** `user_id`, `org_id`, `enduser.id`, `account`: hashed when sent away. */
export function isIdentityField(name: string): boolean {
  return segments(name).some(
    (p) => IDENTITY_SEGMENTS.has(p) || p === 'enduser' || p === 'sub',
  );
}

/** Secrets in any text: each shape and what replaces it. */
const SECRETS: { re: RegExp; sub: string }[] = [
  // JWTs (three base64url parts, the header always starts with `eyJ`)
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    sub: '[redacted]',
  },
  // Authorization values
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, sub: '$1 [redacted]' },
  // GitHub, GitLab, Atlassian, WorkOS, model providers, AWS, Slack, Google, npm
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, sub: '[redacted]' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, sub: '[redacted]' },
  { re: /\bgl[a-z]{2,6}-[A-Za-z0-9_-]{16,}\b/g, sub: '[redacted]' },
  { re: /\bAT(?:BB|ATT)[A-Za-z0-9_-]{16,}\b/g, sub: '[redacted]' },
  { re: /\bsk_(?:test|live)_[A-Za-z0-9]{8,}\b/g, sub: '[redacted]' },
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, sub: '[redacted]' },
  { re: /\bAKIA[A-Z0-9]{16}\b/g, sub: '[redacted]' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, sub: '[redacted]' },
  { re: /\bAIza[A-Za-z0-9_-]{20,}\b/g, sub: '[redacted]' },
  { re: /\bnpm_[A-Za-z0-9]{20,}\b/g, sub: '[redacted]' },
  // Expo push tokens
  { re: /\bExpo(?:nent)?PushToken\[[^\]]*\]/g, sub: '[redacted]' },
  // Passwords in URLs
  { re: /(\w+:\/\/)[^\s/:@]+:[^\s/@]+@/g, sub: '$1[redacted]@' },
  // Sensitive query parameters and `k=v` pairs
  {
    re: /\b(code|state|token|key|api-key|api_key|secret|password|signature|nonce)=([^&\s,"']+)/gi,
    sub: '$1=[redacted]',
  },
  // Private keys
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    sub: '[redacted]',
  },
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** FNV-1a (64-bit) as 16 hex chars: a stable, opaque stand-in for a value. */
export function hashText(s: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const bytes = new TextEncoder().encode(s);
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** Secrets and emails out of a string, then cut to `max`. */
export function redactText(s: string, max = MAX_TEXT): string {
  let out = s;
  for (const { re, sub } of SECRETS) out = out.replace(re, sub);
  out = out.replace(EMAIL, (m) => `<email:${hashText(m.toLowerCase())}>`);
  return truncate(out, max);
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.length - max;
  return `${s.slice(0, max)}…[truncated ${cut} chars]`;
}

const omitted = (v: unknown) =>
  `[omitted: ${typeof v === 'string' ? v.length : (JSON.stringify(v)?.length ?? 0)} bytes]`;

/**
 * Attributes fit for any sink: credential and content fields replaced,
 * strings redacted and bounded, objects flattened to a redacted JSON
 * string, functions and symbols dropped. Keys are kept as given.
 */
export function redactAttrs(attrs: Record<string, unknown>): Attrs {
  const out: Attrs = {};
  for (const [key, raw] of Object.entries(attrs)) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'function' || typeof raw === 'symbol') continue;
    if (isCredentialField(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (isContentField(key)) {
      out[key] =
        typeof raw === 'number' || typeof raw === 'boolean'
          ? raw
          : omitted(raw);
      continue;
    }
    const max = key.endsWith('stack') ? MAX_STACK : MAX_TEXT;
    if (typeof raw === 'string') {
      out[key] = redactText(raw, max);
    } else if (typeof raw === 'number') {
      out[key] = Number.isFinite(raw) ? raw : String(raw);
    } else if (typeof raw === 'boolean') {
      out[key] = raw;
    } else if (typeof raw === 'bigint') {
      out[key] = raw.toString();
    } else {
      let text: string;
      try {
        text = JSON.stringify(raw) ?? String(raw);
      } catch {
        text = '[unserializable]';
      }
      out[key] = redactText(text, max);
    }
  }
  return out;
}

/** The remote rule: identity fields become `h:<hash>`; ids stay matchable. */
export function hashIdentities(attrs: Attrs): Attrs {
  const out: Attrs = {};
  for (const [key, value] of Object.entries(attrs)) {
    out[key] =
      isIdentityField(key) &&
      typeof value === 'string' &&
      value !== '' &&
      !value.startsWith('h:')
        ? `h:${hashText(value)}`
        : value;
  }
  return out;
}
