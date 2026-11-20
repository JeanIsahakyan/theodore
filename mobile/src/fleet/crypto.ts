/**
 * Fleet signatures, byte for byte as `crates/fleet-protocol` makes them
 * (checked against `src/gen/fleet-vectors.json` in the tests).
 *
 * ```text
 * every signature: tag(domain) ‖ bytes        tag = "theodore-fleet-<kind>-v3\0"
 * hello:  bytes = the challenge's 32 raw nonce bytes (anything else: not signed)
 * seal:   bytes = the body's JSON text, UTF-8; envelope{device_id: signer, body, signature}
 * open:   verify(pinned key, tag ‖ body) ─▶ parse ─▶ body's signer = envelope.device_id
 * ```
 */
import type {
  Delegation,
  RemoteAsk,
  RemoteConfirm,
  RemoteOp,
  RemoteRequest,
  ReplyBody,
  SignedEnvelope,
  SpaceEventBody,
} from '../gen/fleet';
import { concat, fromBase64, utf8 } from '../keys/base64';
import { verifySignature } from '../keys/ed25519';
import type { DeviceKey } from '../keys/types';

export type Domain =
  'hello' | 'request' | 'event' | 'ask' | 'reply' | 'delegate' | 'confirm';

/** `Domain::tag` in Rust; a signature for one never verifies as another. */
export const TAGS: Record<Domain, string> = {
  hello: 'theodore-fleet-hello-v3\0',
  request: 'theodore-fleet-request-v3\0',
  event: 'theodore-fleet-event-v3\0',
  ask: 'theodore-fleet-ask-v3\0',
  reply: 'theodore-fleet-reply-v3\0',
  delegate: 'theodore-fleet-delegate-v3\0',
  confirm: 'theodore-fleet-confirm-v3\0',
};

/** The bytes signed for `msg` in `domain`. */
export function domainMessage(domain: Domain, msg: Uint8Array): Uint8Array {
  return concat(utf8(TAGS[domain]), msg);
}

export const NONCE_BYTES = 32;

/**
 * Signs the cloud's challenge for `hello`: `null` unless the nonce is
 * exactly 32 bytes of base64, so the cloud can't get anything else signed.
 */
export async function signHello(
  key: DeviceKey,
  nonceB64: string,
): Promise<string | null> {
  const nonce = fromBase64(nonceB64);
  if (!nonce || nonce.length !== NONCE_BYTES) return null;
  return key.sign(domainMessage('hello', nonce));
}

/** The body types that can be opened, by the domain they're signed for. */
interface Bodies {
  request: RemoteRequest;
  event: SpaceEventBody;
  ask: RemoteAsk;
  reply: ReplyBody;
  delegate: Delegation;
  confirm: RemoteConfirm;
}
export type SignedDomain = keyof Bodies;

/** Who signs a body of each domain (Rust's `Signer`). */
function signerOf(
  domain: SignedDomain,
  body: Record<string, unknown>,
): unknown {
  switch (domain) {
    case 'request':
    case 'delegate':
      return body.origin_device;
    case 'event':
    case 'ask':
    case 'confirm':
      return body.host_device;
    case 'reply':
      return body.target_device;
  }
}

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
  key: DeviceKey,
): Promise<SignedEnvelope> {
  const body = requestBody(req);
  return {
    device_id: req.origin_device,
    body,
    signature: await key.sign(domainMessage('request', utf8(body))),
  };
}

/** The body's JSON without checking anything: for routing only. */
export function peek(envelope: SignedEnvelope): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(envelope.body);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The body, only if `envelope` is signed for `domain` by `publicKey` (the
 * signer's key as pinned here) and the body names the envelope's device as
 * its signer. `null` otherwise.
 */
export function open<D extends SignedDomain>(
  envelope: SignedEnvelope,
  publicKey: string,
  domain: D,
): Bodies[D] | null {
  if (
    typeof envelope?.body !== 'string' ||
    typeof envelope.signature !== 'string' ||
    typeof envelope.device_id !== 'string'
  ) {
    return null;
  }
  const signed = domainMessage(domain, utf8(envelope.body));
  if (!verifySignature(publicKey, signed, envelope.signature)) return null;
  const body = peek(envelope);
  if (!body || signerOf(domain, body) !== envelope.device_id) return null;
  return body as unknown as Bodies[D];
}
