/**
 * The MCP device's keys and signatures, byte for byte as
 * `crates/fleet-protocol` (and the phone, `mobile/src/fleet/crypto.ts`)
 * makes them; checked against `src/gen/fleet-vectors.json` in the tests.
 *
 * ```text
 * key:   Ed25519 made in the cloud, per (user, org); the private half kept
 *        only wrapped: AES-256-GCM under HKDF(MCP_KEY_WRAP), bound to
 *        org, user and public key (AAD)
 * seal:  sign(tag("request") ‖ body JSON in Rust's field order)
 * open:  verify(pinned key, tag(domain) ‖ body) ─▶ the body names the
 *        envelope's device as its signer
 * ```
 */
import type {
  RemoteAsk,
  RemoteOp,
  RemoteRequest,
  ReplyBody,
  SignedEnvelope,
  SpaceEventBody,
} from '../gen/fleet';
import {
  b64,
  signedBytes,
  unb64,
  verifyEnvelope,
  type Domain,
} from '../fleet/wire';

const ED25519 = { name: 'Ed25519' } as const;

/** A fresh device key: the raw public key and the PKCS#8 private key. */
export async function newDeviceKey(): Promise<{
  publicKey: string;
  pkcs8: Uint8Array;
}> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey(
    'raw',
    pair.publicKey,
  )) as ArrayBuffer;
  const pkcs8 = (await crypto.subtle.exportKey(
    'pkcs8',
    pair.privateKey,
  )) as ArrayBuffer;
  return { publicKey: b64(new Uint8Array(raw)), pkcs8: new Uint8Array(pkcs8) };
}

/** AES-256-GCM key for wrapping device keys, derived from the secret. */
async function wrapKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error('MCP_KEY_WRAP is too short');
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode('theodore-mcp-device-key-v1'),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** What a wrapped key is bound to: it opens only for the same row. */
const aad = (org: string, user: string, publicKey: string) =>
  new TextEncoder().encode(`${org}\0${user}\0${publicKey}`);

/** `v1.<iv>.<ciphertext>`, both base64. */
export async function wrapPrivateKey(
  secret: string,
  bound: { org: string; user: string; publicKey: string },
  pkcs8: Uint8Array,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: aad(bound.org, bound.user, bound.publicKey),
    },
    await wrapKey(secret),
    pkcs8,
  );
  return `v1.${b64(iv)}.${b64(new Uint8Array(sealed))}`;
}

/** The signing key back from its wrapped form; throws if it doesn't open. */
export async function unwrapPrivateKey(
  secret: string,
  bound: { org: string; user: string; publicKey: string },
  wrapped: string,
): Promise<CryptoKey> {
  const [v, iv, data] = wrapped.split('.');
  const ivBytes = unb64(iv ?? '');
  const dataBytes = unb64(data ?? '');
  if (v !== 'v1' || !ivBytes || !dataBytes) {
    throw new Error('not a wrapped device key');
  }
  const pkcs8 = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes,
      additionalData: aad(bound.org, bound.user, bound.publicKey),
    },
    await wrapKey(secret),
    dataBytes,
  );
  return crypto.subtle.importKey('pkcs8', pkcs8, ED25519, false, ['sign']);
}

/** Base64 signature over `tag(domain) ‖ msg`. */
export async function signFor(
  key: CryptoKey,
  domain: Domain,
  msg: Uint8Array,
): Promise<string> {
  const sig = await crypto.subtle.sign(ED25519, key, signedBytes(domain, msg));
  return b64(new Uint8Array(sig));
}

/**
 * A human-comparable fingerprint of a public key, as every device shows it
 * (`fleet_protocol::fingerprint`): the first 16 bytes of SHA-256 of the
 * base64 key string, hex, in 8 groups of 4.
 */
export async function fingerprint(publicKey: string): Promise<string> {
  const d = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(publicKey)),
  );
  const hex = [...d.slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.match(/.{4}/g)!.join(' ');
}

/** A fingerprint as a person may type it: hex only, lowercase. */
export const normalizeFingerprint = (s: string) =>
  s.toLowerCase().replace(/[^0-9a-f]/g, '');

/**
 * The op in Rust's field order, absent options as `null` (what serde
 * writes), so a sealed body reads the same as one the desktop makes.
 */
function opInOrder(op: RemoteOp): RemoteOp {
  switch (op.op) {
    case 'start_space':
      return {
        op: 'start_space',
        space: op.space,
        project_id: op.project_id,
        goal: op.goal,
        mode: op.mode,
        agent: op.agent ?? null,
        model: op.model ?? null,
        effort: op.effort ?? null,
        parent: op.parent ?? null,
        depth: op.depth,
        attachments: op.attachments ?? [],
      };
    case 'send':
      return {
        op: 'send',
        space: op.space,
        text: op.text,
        mode: op.mode ?? null,
        agent: op.agent ?? null,
        model: op.model ?? null,
        effort: op.effort ?? null,
        attachments: op.attachments ?? [],
      };
    case 'stop':
      return { op: 'stop', space: op.space };
    case 'answer':
      return {
        op: 'answer',
        space: op.space,
        ask_id: op.ask_id,
        answers: op.answers,
      };
    case 'confirm':
      return { op: 'confirm', confirm_id: op.confirm_id, allow: op.allow };
    case 'set_mcp_auto':
      return {
        op: 'set_mcp_auto',
        mcp_device: op.mcp_device,
        auto: op.auto,
        until_ms: op.until_ms ?? null,
      };
    case 'list_spaces':
      return { op: 'list_spaces', project: op.project ?? null };
    case 'read_space':
      return {
        op: 'read_space',
        space: op.space,
        messages: op.messages ?? null,
      };
    case 'ask_space':
      return { op: 'ask_space', space: op.space, question: op.question };
    case 'send_to':
      return {
        op: 'send_to',
        space: op.space,
        message: op.message,
        attachments: op.attachments ?? [],
      };
    case 'answer_space':
      return {
        op: 'answer_space',
        space: op.space,
        ask: op.ask,
        answers: op.answers,
      };
    case 'merge_child':
      return { op: 'merge_child', parent: op.parent, child: op.child };
    case 'read_file':
      return {
        op: 'read_file',
        space: op.space,
        path: op.path,
        max_bytes: op.max_bytes,
      };
    case 'queued_message':
      return {
        op: 'queued_message',
        space: op.space,
        message: op.message,
        action: op.action,
      };
    case 'archive_space':
      return { op: 'archive_space', space: op.space };
    case 'unarchive_space':
      return { op: 'unarchive_space', space: op.space };
  }
}

/** A request's JSON text, as `serde_json::to_string(&RemoteRequest)`. */
export function requestBody(req: RemoteRequest): string {
  return JSON.stringify({
    req_id: req.req_id,
    origin_device: req.origin_device,
    target_device: req.target_device,
    target_key: req.target_key,
    issued_at_ms: req.issued_at_ms,
    op: opInOrder(req.op),
  });
}

/** A request, signed by its origin (`Domain::Request`). */
export async function seal(
  req: RemoteRequest,
  key: CryptoKey,
): Promise<SignedEnvelope> {
  const body = requestBody(req);
  return {
    device_id: req.origin_device,
    body,
    signature: await signFor(key, 'request', new TextEncoder().encode(body)),
  };
}

interface Bodies {
  event: SpaceEventBody;
  ask: RemoteAsk;
  reply: ReplyBody;
}

/** Who signs a body of each domain (Rust's `Signer`). */
function signerOf(
  domain: keyof Bodies,
  body: Record<string, unknown>,
): unknown {
  return domain === 'reply' ? body.target_device : body.host_device;
}

/**
 * The body, only if `envelope` is signed for `domain` by `publicKey` (the
 * signer's key as pinned by the MCP device) and names the envelope's
 * device as its signer; `null` otherwise.
 */
export async function open<D extends keyof Bodies>(
  envelope: SignedEnvelope,
  publicKey: string,
  domain: D,
): Promise<Bodies[D] | null> {
  if (
    typeof envelope?.body !== 'string' ||
    typeof envelope.signature !== 'string' ||
    typeof envelope.device_id !== 'string'
  ) {
    return null;
  }
  if (!(await verifyEnvelope(publicKey, envelope, domain))) return null;
  let body: unknown;
  try {
    body = JSON.parse(envelope.body);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (signerOf(domain, o) !== envelope.device_id) return null;
  return o as unknown as Bodies[D];
}
