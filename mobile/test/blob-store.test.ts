import { describe, expect, it } from 'vitest';
import {
  BlobHttpError,
  CHUNKS_HEADER,
  createBlobStore,
} from '../src/fleet/blob-store';
import { generatedPlaintext, sealBlob } from '../src/fleet/blob';
import vectors from '../src/gen/fleet-vectors.json';

const PK = vectors.blobs.recipient.public_key;

interface Hit {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

/** A fake Worker: scripted answers per call, every hit recorded. */
function fakeCloud(script: ((hit: Hit, n: number) => Response | Error)[] = []) {
  const hits: Hit[] = [];
  const store = new Map<string, Uint8Array>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}).map(
        ([k, v]) => [k.toLowerCase(), v],
      ),
    );
    const body = init?.body instanceof Uint8Array ? init.body : null;
    const hit: Hit = { method: init?.method ?? 'GET', url, headers, body };
    hits.push(hit);
    const scripted = script.shift();
    if (scripted) {
      const r = scripted(hit, hits.length);
      if (r instanceof Error) throw r;
      return r;
    }
    const m = /\/v1\/fleet\/blobs\/([0-9a-f]+)(?:\/(\d+))?$/.exec(url);
    if (!m) return new Response(null, { status: 404 });
    const key = `${m[1]}/${m[2]}`;
    if (hit.method === 'PUT') {
      store.set(key, body!);
      return new Response(null, { status: 204 });
    }
    if (hit.method === 'GET') {
      const b = store.get(key);
      return b
        ? new Response(b as BodyInit, { status: 200 })
        : Response.json({ code: 'fleet.blob_not_found' }, { status: 404 });
    }
    for (const k of [...store.keys()])
      if (k.startsWith(`${m[1]}/`)) store.delete(k);
    return new Response(null, { status: 204 });
  };
  return { hits, store, fetch: fetchImpl };
}

const setup = (
  cloud: ReturnType<typeof fakeCloud>,
  over: { attempts?: number; token?: string | null } = {},
) => {
  const slept: number[] = [];
  const blobs = createBlobStore({
    cloudUrl: 'https://cloud.test/',
    fetch: cloud.fetch,
    token: async () => (over.token === undefined ? 'jwt-1' : over.token),
    attempts: over.attempts,
    backoffMs: 10,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  return { blobs, slept };
};

describe('blob store: upload', () => {
  it('PUTs every chunk in order with the bearer and the chunk count, reporting progress', async () => {
    const cloud = fakeCloud();
    const { blobs } = setup(cloud);
    const { ref, chunks } = sealBlob(
      PK,
      generatedPlaintext(4 * 1024 * 1024 + 3),
      'big.bin',
      '',
    );
    const progress: [number, number][] = [];
    await blobs.upload(ref, chunks, (d, t) => progress.push([d, t]));
    expect(cloud.hits.map((h) => h.method)).toEqual(['PUT', 'PUT']);
    expect(cloud.hits[0]!.url).toBe(
      `https://cloud.test/v1/fleet/blobs/${ref.blob_id}/0`,
    );
    expect(cloud.hits[1]!.url).toBe(
      `https://cloud.test/v1/fleet/blobs/${ref.blob_id}/1`,
    );
    for (const h of cloud.hits) {
      expect(h.headers.authorization).toBe('Bearer jwt-1');
      expect(h.headers[CHUNKS_HEADER]).toBe('2');
      expect(h.headers['content-type']).toBe('application/octet-stream');
    }
    expect(cloud.hits[0]!.body).toBe(chunks[0]);
    const total = chunks[0]!.length + chunks[1]!.length;
    expect(progress).toEqual([
      [0, total],
      [chunks[0]!.length, total],
      [total, total],
    ]);
  });

  it('retries a chunk after a network error or a 5xx, then goes on', async () => {
    const cloud = fakeCloud([
      () => new TypeError('network down'),
      () => new Response(null, { status: 503 }),
    ]);
    const { blobs, slept } = setup(cloud);
    const { ref, chunks } = sealBlob(
      PK,
      generatedPlaintext(10),
      'ten.txt',
      'text/plain',
    );
    await blobs.upload(ref, chunks);
    expect(cloud.hits).toHaveLength(3);
    expect(cloud.hits.every((h) => h.url.endsWith('/0'))).toBe(true);
    expect(slept).toEqual([10, 20]);
    expect(cloud.store.size).toBe(1);
  });

  it('gives up after the last try', async () => {
    const cloud = fakeCloud([
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 502 }),
      () => new Response(null, { status: 503 }),
    ]);
    const { blobs } = setup(cloud);
    const { ref, chunks } = sealBlob(PK, generatedPlaintext(10), 'ten.txt', '');
    await expect(blobs.upload(ref, chunks)).rejects.toMatchObject({
      status: 503,
    });
    expect(cloud.hits).toHaveLength(3);
  });

  it('fails at once on a refusal, with its code', async () => {
    const cloud = fakeCloud([
      () =>
        Response.json(
          { code: 'fleet.quota', error: { code: 'fleet.quota' } },
          { status: 429 },
        ),
    ]);
    const { blobs } = setup(cloud);
    const { ref, chunks } = sealBlob(PK, generatedPlaintext(10), 'ten.txt', '');
    const err = await blobs.upload(ref, chunks).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlobHttpError);
    expect((err as BlobHttpError).code).toBe('fleet.quota');
    expect((err as BlobHttpError).message).toMatch(/quota/);
    expect(cloud.hits).toHaveLength(1);
  });

  it('reads the code from the header when there is one', async () => {
    const cloud = fakeCloud([
      () =>
        new Response(null, {
          status: 413,
          headers: { 'x-theodore-error': 'fleet.too_large' },
        }),
    ]);
    const { blobs } = setup(cloud);
    const { ref, chunks } = sealBlob(PK, generatedPlaintext(10), 'ten.txt', '');
    await expect(blobs.upload(ref, chunks)).rejects.toMatchObject({
      code: 'fleet.too_large',
    });
  });

  it('needs a session', async () => {
    const cloud = fakeCloud();
    const { blobs } = setup(cloud, { token: null });
    const { ref, chunks } = sealBlob(PK, generatedPlaintext(10), 'ten.txt', '');
    await expect(blobs.upload(ref, chunks)).rejects.toMatchObject({
      code: 'fleet.unauthorized',
    });
    expect(cloud.hits).toHaveLength(0);
  });

  it("refuses a chunk list that is not the reference's", async () => {
    const cloud = fakeCloud();
    const { blobs } = setup(cloud);
    const { ref, chunks } = sealBlob(PK, generatedPlaintext(10), 'ten.txt', '');
    await expect(blobs.upload(ref, [...chunks, chunks[0]!])).rejects.toThrow(
      /expected 1/,
    );
  });

  it('stops when cancelled', async () => {
    const cloud = fakeCloud([() => new Response(null, { status: 500 })]);
    const ctl = new AbortController();
    const blobs = createBlobStore({
      cloudUrl: 'https://cloud.test',
      fetch: cloud.fetch,
      token: async () => 't',
      backoffMs: 1,
      sleep: async () => ctl.abort(),
    });
    const { ref, chunks } = sealBlob(PK, generatedPlaintext(10), 'ten.txt', '');
    await expect(
      blobs.upload(ref, chunks, undefined, ctl.signal),
    ).rejects.toThrow(/cancelled/);
    expect(cloud.hits).toHaveLength(1);
  });
});

describe('blob store: download and remove', () => {
  it('GETs every chunk, retries transient failures, and DELETEs the blob', async () => {
    const cloud = fakeCloud();
    const { blobs } = setup(cloud);
    const { ref, chunks } = sealBlob(
      PK,
      generatedPlaintext(4 * 1024 * 1024 + 3),
      'big.bin',
      '',
    );
    await blobs.upload(ref, chunks);
    cloud.hits.length = 0;
    // The first GET fails once.
    const first = cloud.fetch;
    let failed = false;
    const flaky: typeof fetch = async (i, init) => {
      if (!failed && init?.method === 'GET') {
        failed = true;
        return new Response(null, { status: 500 });
      }
      return first(i, init);
    };
    const store = createBlobStore({
      cloudUrl: 'https://cloud.test',
      fetch: flaky,
      token: async () => 'jwt-1',
      backoffMs: 1,
      sleep: async () => {},
    });
    const progress: number[] = [];
    const got = await store.download(ref, (d) => progress.push(d));
    expect(got.map((c) => c.length)).toEqual(chunks.map((c) => c.length));
    expect(got[0]).toEqual(chunks[0]);
    expect(progress).toEqual([
      0,
      chunks[0]!.length,
      chunks[0]!.length + chunks[1]!.length,
    ]);
    await store.remove(ref.blob_id);
    expect(cloud.store.size).toBe(0);
    const del = cloud.hits.find((h) => h.method === 'DELETE')!;
    expect(del.url).toBe(`https://cloud.test/v1/fleet/blobs/${ref.blob_id}`);
    expect(del.headers.authorization).toBe('Bearer jwt-1');
  });

  it('a missing chunk fails at once as not found', async () => {
    const cloud = fakeCloud();
    const { blobs } = setup(cloud);
    const { ref } = sealBlob(PK, generatedPlaintext(10), 'ten.txt', '');
    const err = await blobs.download(ref).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlobHttpError);
    expect((err as BlobHttpError).code).toBe('fleet.blob_not_found');
    expect(cloud.hits).toHaveLength(1);
  });
});
