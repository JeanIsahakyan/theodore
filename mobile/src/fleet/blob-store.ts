/**
 * The cloud's blob store as this app uses it (docs/cloud.md "Blobs",
 * docs/fleet.md "Files (blobs)"): ciphertext chunks in, out and gone.
 * Bearer = the account's session JWT; the Worker never sees a key.
 *
 * ```text
 * upload(ref, chunks)    PUT /v1/fleet/blobs/<id>/<i>  x-theodore-chunks: N ─▶ 204   per chunk, in order
 *                          network error / 5xx ─▶ again, up to `attempts` (backoff)
 *                          4xx (fleet.invalid, fleet.too_large, fleet.quota, fleet.unauthorized) ─▶ fails now
 *                        progress: bytes done / bytes total, after every chunk
 * download(ref)          GET …/<id>/<i> ─▶ 200 bytes   the same retry; 404 fleet.blob_not_found fails now
 * remove(id)             DELETE …/<id> ─▶ 204 (already gone: 204)
 * ```
 */
import type { BlobRef } from '../gen/fleet';
import { FleetError } from './errors';
import { safeCode } from './rules';

export const BLOBS_PATH = '/v1/fleet/blobs';
export const CHUNKS_HEADER = 'x-theodore-chunks';

export interface BlobStoreDeps {
  cloudUrl: string;
  fetch: typeof fetch;
  /** The session's access token; `null` when signed out. */
  token: () => Promise<string | null>;
  /** Tries per chunk (a network error or a 5xx between them). Default 3. */
  attempts?: number;
  /** Before the second try; doubles after. Default 500 ms. */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Bytes done of bytes total, after every chunk (`total` counts tags). */
export type BlobProgress = (done: number, total: number) => void;

export interface BlobStore {
  /** One chunk, one try. */
  put(
    blobId: string,
    i: number,
    chunks: number,
    bytes: Uint8Array,
  ): Promise<void>;
  /** One chunk, one try. */
  get(blobId: string, i: number): Promise<Uint8Array>;
  /** Every chunk of the blob; already gone is fine. */
  remove(blobId: string): Promise<void>;
  /** Every chunk in order, each retried on a network error or a 5xx. */
  upload(
    ref: BlobRef,
    chunks: readonly Uint8Array[],
    onProgress?: BlobProgress,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Every chunk in order, the same retry. */
  download(
    ref: BlobRef,
    onProgress?: BlobProgress,
    signal?: AbortSignal,
  ): Promise<Uint8Array[]>;
}

/** A cloud refusal of a blob request: its status and code. */
export class BlobHttpError extends FleetError {
  constructor(
    readonly status: number,
    code: string,
  ) {
    super(blobErrorText(status, code), code);
    this.name = 'BlobHttpError';
  }
  /** Worth another try: the cloud or the network, not this request. */
  get transient(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

function blobErrorText(status: number, code: string): string {
  switch (code) {
    case 'fleet.blob_not_found':
      return 'the file is no longer in the cloud (fleet.blob_not_found)';
    case 'fleet.too_large':
      return 'the file is too large to send (fleet.too_large)';
    case 'fleet.quota':
      return "today's upload quota is used up (fleet.quota)";
    case 'fleet.unauthorized':
      return 'the cloud refused the session: sign in again (fleet.unauthorized)';
    default:
      return status === 0
        ? 'the cloud could not be reached'
        : `the cloud refused the file (${code})`;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export function createBlobStore(deps: BlobStoreDeps): BlobStore {
  const base = `${deps.cloudUrl.replace(/\/+$/, '')}${BLOBS_PATH}`;
  const attempts = Math.max(1, deps.attempts ?? 3);
  const backoff = deps.backoffMs ?? 500;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const headers = async (extra: Record<string, string> = {}) => {
    const token = await deps.token();
    if (!token) throw new BlobHttpError(401, 'fleet.unauthorized');
    return { authorization: `Bearer ${token}`, ...extra };
  };

  /** The refusal in a non-2xx answer (its code from the body or header). */
  const refusal = async (res: Response): Promise<BlobHttpError> => {
    let code = res.headers.get('x-theodore-error') ?? '';
    if (!code) {
      const json: unknown = await res.json().catch(() => null);
      const body = isObj(json) ? json : {};
      const inner = isObj(body.error) ? body.error : null;
      code = String(body.code ?? inner?.code ?? '');
    }
    return new BlobHttpError(
      res.status,
      code
        ? safeCode(code)
        : res.status >= 500
          ? 'cloud.unavailable'
          : 'fleet.invalid',
    );
  };

  const send = async (input: string, init: RequestInit): Promise<Response> => {
    let res: Response;
    try {
      res = await deps.fetch(input, init);
    } catch (e) {
      if (init.signal?.aborted) throw e;
      throw new BlobHttpError(0, 'cloud.unreachable');
    }
    if (!res.ok) throw await refusal(res);
    return res;
  };

  const chunkPath = (blobId: string, i: number) =>
    `${base}/${encodeURIComponent(blobId)}/${i}`;

  const put: BlobStore['put'] = async (blobId, i, chunks, bytes) => {
    await send(chunkPath(blobId, i), {
      method: 'PUT',
      headers: await headers({
        'content-type': 'application/octet-stream',
        [CHUNKS_HEADER]: String(chunks),
      }),
      body: bytes as BodyInit,
    });
  };

  const get: BlobStore['get'] = async (blobId, i) => {
    const res = await send(chunkPath(blobId, i), {
      method: 'GET',
      headers: await headers(),
    });
    return new Uint8Array(await res.arrayBuffer());
  };

  const remove: BlobStore['remove'] = async (blobId) => {
    await send(`${base}/${encodeURIComponent(blobId)}`, {
      method: 'DELETE',
      headers: await headers(),
    });
  };

  /** `op` up to `attempts` times while its failures are transient. */
  const retried = async <T>(
    op: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    for (let n = 1; ; n++) {
      if (signal?.aborted) throw new FleetError('cancelled');
      try {
        return await op();
      } catch (e) {
        const again = n < attempts && e instanceof BlobHttpError && e.transient;
        if (!again) throw e;
        await sleep(backoff * 2 ** (n - 1));
      }
    }
  };

  return {
    put,
    get,
    remove,
    async upload(ref, chunks, onProgress, signal) {
      if (chunks.length !== ref.chunks)
        throw new FleetError(
          `expected ${ref.chunks} chunks, got ${chunks.length}`,
        );
      const total = chunks.reduce((n, c) => n + c.length, 0);
      let done = 0;
      onProgress?.(0, total);
      for (let i = 0; i < chunks.length; i++) {
        const bytes = chunks[i]!;
        await retried(() => put(ref.blob_id, i, ref.chunks, bytes), signal);
        done += bytes.length;
        onProgress?.(done, total);
      }
    },
    async download(ref, onProgress, signal) {
      // Every chunk's share plus its tag: the ciphertext size.
      const total = ref.size + ref.chunks * 16;
      let done = 0;
      onProgress?.(0, total);
      const out: Uint8Array[] = [];
      for (let i = 0; i < ref.chunks; i++) {
        const bytes = await retried(() => get(ref.blob_id, i), signal);
        out.push(bytes);
        done += bytes.length;
        onProgress?.(Math.min(done, total), total);
      }
      return out;
    },
  };
}
