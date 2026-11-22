/**
 * Blobs: file transfer between an org's devices through R2 (docs/cloud.md
 * "Blobs"). The devices encrypt end to end; the Worker moves ciphertext and
 * never sees a key.
 *
 * ```text
 * sender    ─PUT /v1/fleet/blobs/<blob>/<i>, x-theodore-chunks: N, Bearer JWT─▶ Worker
 *   ─▶ verify (401) ─▶ RL_USER ─▶ N in 1..=64, i < N, Content-Length ≤ 4 MiB + 64 (411 / 413)
 *   ─▶ blobs/_owner/<blob>: none ─▶ written {org, chunks}; another org's or another N ─▶ 400
 *   ─▶ OrgHub(org) POST /v1/fleet/blob-quota {bytes} ─▶ per user per UTC day ≤ 1 GiB, 2000 chunks (429)
 *   ─▶ R2 put blobs/<org>/<blob>/<i> ◀─ request.body streamed, metadata {uploader, org, chunks, uploaded_at}
 *   ─▶ 204                                            (a retry of the same i overwrites)
 * recipient ─GET  …/<blob>/<i>─▶ the same org's object streamed, 200 octet-stream │ 404
 *           ─DELETE …/<blob>─▶ every chunk under blobs/<org>/<blob>/ and the owner mark ─▶ 204
 * R2 lifecycle (blobs/, 24 h) ─▶ whatever a recipient never fetched
 * ```
 *
 * Errors are `{ code, error: { code, message } }`: the code at the top as
 * the file-transfer contract says, nested as every other route answers.
 */
import type { Caller } from '../auth';
import { CloudError, ERROR_HEADER } from '../errors';
import { noopLogger, type Logger } from '../telemetry/log';
import type { FleetCaller } from './hub';
import {
  BLOB_CHUNK_BYTES,
  BLOB_DAY_BYTES,
  BLOB_DAY_CHUNKS,
  BLOB_ID,
  BLOB_MAX_CHUNKS,
  codes,
} from './limits';
import { CALLER_HEADER, requestCaller, type HubFor } from './route';
import type { Sql } from './store';

/** Every blob route lives under this; the rest of the path is `<blob>[/<i>]`. */
export const BLOBS_PATH = '/v1/fleet/blobs/';
/** The path the DO counts an upload on (never routed from outside). */
export const QUOTA_PATH = '/v1/fleet/blob-quota';
/** How many chunks the blob has, on every PUT. */
export const CHUNKS_HEADER = 'x-theodore-chunks';
/** The R2 key prefix the lifecycle rule applies to. */
export const BLOBS_PREFIX = 'blobs/';

/** The part of `R2Bucket` the routes use (a fake in tests). */
export type BlobBucket = Pick<
  R2Bucket,
  'head' | 'get' | 'put' | 'delete' | 'list'
>;

export interface BlobDeps {
  verify: (token: string) => Promise<Caller>;
  /** The `BLOBS` binding; absent: `cloud.config`. */
  bucket?: BlobBucket;
  /** The org's hub, which keeps the daily counter; absent: `cloud.config`. */
  hub?: HubFor;
  /** The per-user rate limit (`RL_USER`); throws when over. */
  rateLimit: (userId: string) => Promise<void>;
  /** The cloud's logger; ids in its records are hashed before they leave. */
  log?: Logger;
}

const invalid = (why: string) => new CloudError(400, codes.INVALID, why);

const chunkKey = (org: string, blob: string, i: number) =>
  `${BLOBS_PREFIX}${org}/${blob}/${i}`;
const blobPrefix = (org: string, blob: string) =>
  `${BLOBS_PREFIX}${org}/${blob}/`;
/** Who owns a blob id: org ids never start with `_`, so no org collides. */
const ownerKey = (blob: string) => `${BLOBS_PREFIX}_owner/${blob}`;

/** `/v1/fleet/blobs/<blob>[/<i>]` taken apart; anything else is 404. */
function parsePath(path: string): { blob: string; index?: string } {
  const rest = path.slice(BLOBS_PATH.length).split('/');
  const blob = rest[0];
  if (!blob || rest.length > 2 || rest[1] === '') {
    throw new CloudError(404, 'cloud.not_found', 'no such route');
  }
  return { blob, index: rest[1] };
}

function blobId(raw: string): string {
  if (!BLOB_ID.test(raw)) throw invalid('blob id is 32 lowercase hex chars');
  return raw;
}

/** A chunk index as written: decimal, no sign, no leading zero. */
function chunkIndex(raw: string | undefined): number {
  if (raw === undefined || !/^(0|[1-9][0-9]?)$/.test(raw)) {
    throw invalid('chunk index is 0 ≤ i < chunks');
  }
  return Number(raw);
}

function chunkCount(request: Request): number {
  const raw = request.headers.get(CHUNKS_HEADER) ?? '';
  const n = /^[1-9][0-9]?$/.test(raw) ? Number(raw) : 0;
  if (n < 1 || n > BLOB_MAX_CHUNKS) {
    throw invalid(`${CHUNKS_HEADER} is 1..=${BLOB_MAX_CHUNKS}`);
  }
  return n;
}

/** The declared body length: R2 needs it to stream, so a chunked body is refused. */
function declaredLength(request: Request): number {
  const raw = request.headers.get('content-length');
  if (raw === null || !/^[0-9]{1,12}$/.test(raw)) {
    throw new CloudError(411, codes.INVALID, 'content-length is required');
  }
  const n = Number(raw);
  if (n > BLOB_CHUNK_BYTES) {
    throw new CloudError(413, codes.TOO_LARGE, 'chunk over 4 MiB + 64');
  }
  if (n === 0 || request.body === null) throw invalid('a chunk has bytes');
  return n;
}

function errorBody(e: CloudError): Response {
  return new Response(
    JSON.stringify({
      code: e.code,
      error: { code: e.code, message: e.message },
    }),
    {
      status: e.status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        [ERROR_HEADER]: e.code,
      },
    },
  );
}

const noContent = () =>
  new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });

/** The routes under `/v1/fleet/blobs/`; `path` already starts with it. */
export async function blobRoute(
  request: Request,
  path: string,
  deps: BlobDeps,
): Promise<Response> {
  try {
    const { blob, index } = parsePath(path);
    const method = request.method;
    const withIndex = index !== undefined;
    const handler =
      method === 'PUT' && withIndex
        ? putChunk
        : method === 'GET' && withIndex
          ? getChunk
          : method === 'DELETE' && !withIndex
            ? deleteBlob
            : null;
    if (!handler) {
      throw new CloudError(405, 'cloud.method', `${method} not allowed`);
    }
    const caller = await requestCaller(request, deps.verify);
    await deps.rateLimit(caller.userId);
    const bucket = deps.bucket;
    if (!bucket) {
      throw new CloudError(500, 'cloud.config', 'blobs are not configured');
    }
    const log = (deps.log ?? noopLogger).child({
      component: 'blobs',
      user_id: caller.userId,
      org_id: caller.orgId,
    });
    return await handler(request, { blob, index, caller, bucket, deps, log });
  } catch (e) {
    if (e instanceof CloudError) {
      // Who was turned away and why (static words); the request line
      // carries the status and code for the rest.
      if (e.status === 401 || e.status === 403) {
        deps.log?.info('auth failed', { code: e.code, reason: e.message });
      } else if (e.status >= 500) {
        deps.log?.warn('request failed', {
          code: e.code,
          status: e.status,
          reason: e.message,
        });
      }
      return errorBody(e);
    }
    throw e;
  }
}

interface Call {
  blob: string;
  index?: string;
  caller: FleetCaller;
  bucket: BlobBucket;
  deps: BlobDeps;
  /** With the caller's (hashed) ids. */
  log: Logger;
}

async function putChunk(request: Request, c: Call): Promise<Response> {
  const blob = blobId(c.blob);
  const chunks = chunkCount(request);
  const i = chunkIndex(c.index);
  if (i >= chunks) throw invalid('chunk index is 0 ≤ i < chunks');
  const length = declaredLength(request);
  const org = c.caller.orgId;

  const owner = await c.bucket.head(ownerKey(blob));
  if (owner) {
    const meta = owner.customMetadata ?? {};
    if (meta['org_id'] !== org || Number(meta['chunks']) !== chunks) {
      throw invalid(
        'the blob belongs to another org or has another chunk count',
      );
    }
  }
  try {
    await reserveBlobQuota(c.deps.hub, request.url, c.caller, length);
  } catch (e) {
    if (e instanceof CloudError && e.code === codes.QUOTA) {
      c.log.info('quota hit', { code: e.code, op: 'blob_put', bytes: length });
    }
    throw e;
  }

  const customMetadata = {
    uploader: c.caller.userId,
    org_id: org,
    chunks: String(chunks),
    uploaded_at: new Date().toISOString(),
  };
  if (!owner) {
    // Two first chunks of one blob racing here write the same mark.
    await c.bucket.put(ownerKey(blob), '', { customMetadata });
  }
  // The body streams through: a request body's length is its Content-Length,
  // which R2 needs, so the chunk is never held in memory here.
  await c.bucket.put(chunkKey(org, blob, i), request.body, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata,
  });
  c.log.info('blob put', { index: i, chunks, bytes: length, first: !owner });
  return noContent();
}

async function getChunk(_request: Request, c: Call): Promise<Response> {
  const blob = blobId(c.blob);
  const i = chunkIndex(c.index);
  const object = await c.bucket.get(chunkKey(c.caller.orgId, blob, i));
  if (!object) {
    c.log.info('blob missing', { index: i });
    throw new CloudError(404, codes.BLOB_NOT_FOUND, 'no such blob chunk');
  }
  c.log.info('blob get', { index: i, bytes: object.size });
  return new Response(object.body, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(object.size),
      'cache-control': 'no-store',
    },
  });
}

async function deleteBlob(_request: Request, c: Call): Promise<Response> {
  const blob = blobId(c.blob);
  const org = c.caller.orgId;
  // ≤ 64 chunks: one page.
  const listed = await c.bucket.list({ prefix: blobPrefix(org, blob) });
  const keys = listed.objects.map((o) => o.key);
  const owner = await c.bucket.head(ownerKey(blob));
  if (owner?.customMetadata?.['org_id'] === org) keys.push(ownerKey(blob));
  if (keys.length > 0) await c.bucket.delete(keys);
  c.log.info('blob delete', { objects: keys.length });
  return noContent();
}

// ─── The daily counter, in the org's hub ────────────────────────────────────

/** What one day may take; tests pass smaller ones. */
export interface BlobQuotaLimits {
  bytes: number;
  chunks: number;
}

/** `blob_quota`: per (user, UTC day) the bytes and chunks uploaded so far. */
export class BlobQuota {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => number,
    private readonly limits: BlobQuotaLimits = {
      bytes: BLOB_DAY_BYTES,
      chunks: BLOB_DAY_CHUNKS,
    },
  ) {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS blob_quota (
         user_id TEXT NOT NULL,
         day TEXT NOT NULL,
         bytes INTEGER NOT NULL,
         chunks INTEGER NOT NULL,
         PRIMARY KEY (user_id, day)
       )`,
    );
  }

  private day(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** Counts one chunk of `bytes` for `user` today; `false`: over, not counted. */
  reserve(user: string, bytes: number): boolean {
    const day = this.day();
    // Yesterday's rows are of no use: one statement keeps the table tiny.
    this.sql.exec('DELETE FROM blob_quota WHERE day < ?', day);
    const row = this.sql.exec(
      'SELECT bytes, chunks FROM blob_quota WHERE user_id = ? AND day = ?',
      user,
      day,
    )[0] as { bytes: number; chunks: number } | undefined;
    const used = row ?? { bytes: 0, chunks: 0 };
    if (
      used.bytes + bytes > this.limits.bytes ||
      used.chunks + 1 > this.limits.chunks
    ) {
      return false;
    }
    this.sql.exec(
      `INSERT INTO blob_quota (user_id, day, bytes, chunks) VALUES (?, ?, ?, 1)
       ON CONFLICT (user_id, day) DO UPDATE
         SET bytes = bytes + excluded.bytes, chunks = chunks + 1`,
      user,
      day,
      bytes,
    );
    return true;
  }

  purgeUser(user: string): void {
    this.sql.exec('DELETE FROM blob_quota WHERE user_id = ?', user);
  }

  purgeAll(): void {
    this.sql.exec('DELETE FROM blob_quota');
  }
}

/** Inside the DO: `POST /v1/fleet/blob-quota {bytes}` ─▶ 200 counted │ 429 over. */
export async function answerBlobQuota(
  quota: BlobQuota,
  caller: FleetCaller,
  request: Request,
): Promise<Response> {
  let bytes: unknown;
  try {
    bytes = ((await request.json()) as { bytes?: unknown }).bytes;
  } catch {
    // answered below
  }
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
    return Response.json(
      { error: { code: 'cloud.bad_request', message: 'bad bytes' } },
      { status: 400 },
    );
  }
  const ok = quota.reserve(caller.userId, bytes);
  return Response.json(ok ? { ok: true } : { ok: false, code: codes.QUOTA }, {
    status: ok ? 200 : 429,
    headers: { 'cache-control': 'no-store' },
  });
}

/** The Worker's side: counts the upload in the org's hub, or `fleet.quota`. */
export async function reserveBlobQuota(
  hubFor: HubFor | undefined,
  url: string,
  caller: FleetCaller,
  bytes: number,
): Promise<void> {
  if (!hubFor) {
    throw new CloudError(500, 'cloud.config', 'the fleet is not configured');
  }
  const res = await hubFor(caller.orgId).fetch(
    new Request(new URL(QUOTA_PATH, url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CALLER_HEADER]: JSON.stringify(caller),
      },
      body: JSON.stringify({ bytes }),
    }),
  );
  if (res.status === 429) {
    throw new CloudError(429, codes.QUOTA, 'blob upload quota spent for today');
  }
  if (res.status === 401) {
    throw new CloudError(401, codes.UNAUTHORIZED, 'the account was deleted');
  }
  if (!res.ok) {
    throw new CloudError(500, 'cloud.internal', 'the fleet hub failed');
  }
}
