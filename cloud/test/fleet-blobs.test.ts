// /v1/fleet/blobs: encrypted file chunks through R2 (src/fleet/blobs.ts).
// The routes run against an in-memory R2 and a hub that keeps the daily
// counter in node:sqlite behind the same handler the OrgHub runs.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { verifyAccessToken } from '../src/auth';
import {
  answerBlobQuota,
  BlobQuota,
  CHUNKS_HEADER,
  QUOTA_PATH,
  type BlobBucket,
  type BlobQuotaLimits,
} from '../src/fleet/blobs';
import { BLOB_CHUNK_BYTES } from '../src/fleet/limits';
import { CALLER_HEADER, OrgHub, readCaller } from '../src/fleet/org-hub';
import { PURGE_PATH } from '../src/fleet/route';
import { handle, type Deps } from '../src/index';
import { Logger, type LogRecord } from '../src/telemetry/log';
import { FakeWorkos } from './fake-workos';
import { MCP_TEST_SECRET } from './fleet-harness';
import { API, CLIENT, signer } from './keys';
import { doState, FakeR2 } from './workers-fakes';

const ORIGIN = 'https://cloud.test';
const WEB = 'https://web.test';
const BLOB = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

interface ErrorBody {
  code: string;
  error: { code: string; message: string };
}

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

async function setup(o: { quota?: BlobQuotaLimits; bucket?: boolean } = {}) {
  const { keys, sign } = await signer();
  const r2 = new FakeR2();
  const db = new DatabaseSync(':memory:');
  let now = Date.UTC(2026, 10, 21, 12);
  const quota = new BlobQuota(
    { exec: (q, ...b) => db.prepare(q).all(...b) as Record<string, unknown>[] },
    () => now,
    o.quota,
  );
  const hubCalls: string[] = [];
  const limited: string[] = [];
  const deps: Deps = {
    workos: new FakeWorkos(),
    clientId: CLIENT,
    verify: (t) =>
      verifyAccessToken(t, { apiBase: API, clientId: CLIENT, keys }),
    blobs: o.bucket === false ? undefined : (r2 as unknown as BlobBucket),
    hub: (org) => ({
      fetch: async (req) => {
        hubCalls.push(`${org} ${req.method} ${new URL(req.url).pathname}`);
        const caller = readCaller(req.headers.get(CALLER_HEADER))!;
        if (new URL(req.url).pathname !== QUOTA_PATH) {
          return new Response('nope', { status: 500 });
        }
        return answerBlobQuota(quota, caller, req);
      },
    }),
    limit: async (bucket, key) => {
      limited.push(`${bucket}:${key}`);
      return true;
    },
  };
  const tokens = new Map<string, Promise<string>>();
  const token = (user: string, org?: string) => {
    const k = `${user}/${org ?? ''}`;
    let t = tokens.get(k);
    if (!t) {
      t = sign(org ? { sub: user, org_id: org } : { sub: user });
      tokens.set(k, t);
    }
    return t;
  };
  const call = async (
    path: string,
    init: RequestInit & { as?: [string, string?] | null; origin?: string },
  ) => {
    const { as = ['user_1', 'org_7'], origin, ...rest } = init;
    const headers: Record<string, string> = {
      ...(rest.headers as Record<string, string> | undefined),
    };
    if (as) headers['authorization'] = `Bearer ${await token(...as)}`;
    if (origin) headers['origin'] = origin;
    return handle(
      new Request(`${ORIGIN}${path}`, { ...rest, headers }),
      () => deps,
      [WEB],
    );
  };
  /** PUT one chunk, Content-Length set as a real client sends it. */
  const put = (
    i: number | string,
    body: Uint8Array,
    o: {
      blob?: string;
      chunks?: number | string | null;
      length?: string | null;
      as?: [string, string?] | null;
      origin?: string;
    } = {},
  ) => {
    const headers: Record<string, string> = {};
    if (o.chunks !== null) headers[CHUNKS_HEADER] = String(o.chunks ?? 2);
    if (o.length !== null) {
      headers['content-length'] = o.length ?? String(body.byteLength);
    }
    return call(`/v1/fleet/blobs/${o.blob ?? BLOB}/${i}`, {
      method: 'PUT',
      headers,
      body: body as BodyInit,
      as: o.as,
      origin: o.origin,
    });
  };
  const get = (
    i: number | string,
    o: { blob?: string; as?: [string, string?] | null } = {},
  ) =>
    call(`/v1/fleet/blobs/${o.blob ?? BLOB}/${i}`, { method: 'GET', as: o.as });
  const del = (o: { blob?: string; as?: [string, string?] | null } = {}) =>
    call(`/v1/fleet/blobs/${o.blob ?? BLOB}`, { method: 'DELETE', as: o.as });
  const error = async (r: Response) => (await r.json()) as ErrorBody;
  const codeOf = async (r: Response, status: number) => {
    const body = await error(r);
    expect([r.status, body.code, body.error.code]).toEqual([
      status,
      body.code,
      body.code,
    ]);
    return body.code;
  };
  return {
    r2,
    db,
    deps,
    token,
    quota,
    hubCalls,
    limited,
    call,
    put,
    get,
    del,
    error,
    codeOf,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('PUT, GET, DELETE /v1/fleet/blobs', () => {
  it('round trip: two chunks up, streamed to R2 with metadata, down again, then gone', async () => {
    const s = await setup();
    const a = bytes(100 * 1024, 1);
    const b = bytes(16, 2);
    expect((await s.put(0, a)).status).toBe(204);
    expect((await s.put(1, b)).status).toBe(204);
    expect(s.r2.keys()).toEqual([
      `blobs/_owner/${BLOB}`,
      `blobs/org_7/${BLOB}/0`,
      `blobs/org_7/${BLOB}/1`,
    ]);
    expect(s.r2.streamed).toBe(2);
    const meta = s.r2.objects.get(`blobs/org_7/${BLOB}/1`)!.customMetadata;
    expect(meta).toMatchObject({
      uploader: 'user_1',
      org_id: 'org_7',
      chunks: '2',
    });
    expect(Date.parse(meta['uploaded_at']!)).toBeGreaterThan(0);
    expect(s.hubCalls).toEqual([
      `org_7 POST ${QUOTA_PATH}`,
      `org_7 POST ${QUOTA_PATH}`,
    ]);
    expect(s.limited).toEqual(['user:user_1', 'user:user_1']);

    const r0 = await s.get(0);
    expect(r0.status).toBe(200);
    expect(r0.headers.get('content-type')).toBe('application/octet-stream');
    expect(r0.headers.get('content-length')).toBe(String(a.byteLength));
    expect(r0.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await r0.arrayBuffer())).toEqual(a);
    expect(new Uint8Array(await (await s.get(1)).arrayBuffer())).toEqual(b);

    expect((await s.del()).status).toBe(204);
    expect(s.r2.keys()).toEqual([]);
    expect(await s.codeOf(await s.get(0), 404)).toBe('fleet.blob_not_found');
    // Idempotent.
    expect((await s.del()).status).toBe(204);
  });

  it('a retry of the same index overwrites', async () => {
    const s = await setup();
    expect((await s.put(0, bytes(32, 1))).status).toBe(204);
    expect((await s.put(0, bytes(48, 9))).status).toBe(204);
    const r = await s.get(0);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes(48, 9));
    expect(s.r2.keys('blobs/org_7/')).toEqual([`blobs/org_7/${BLOB}/0`]);
  });

  it('keeps blobs to their org', async () => {
    const s = await setup();
    expect((await s.put(0, bytes(32))).status).toBe(204);
    const other: [string, string] = ['user_2', 'org_8'];
    expect(await s.codeOf(await s.get(0, { as: other }), 404)).toBe(
      'fleet.blob_not_found',
    );
    // The id is taken: another org can't add chunks to it.
    expect(await s.codeOf(await s.put(1, bytes(32), { as: other }), 400)).toBe(
      'fleet.invalid',
    );
    // Deleting it from elsewhere deletes nothing.
    expect((await s.del({ as: other })).status).toBe(204);
    expect(s.r2.keys()).toEqual([
      `blobs/_owner/${BLOB}`,
      `blobs/org_7/${BLOB}/0`,
    ]);
    // Another user of the same org may fetch it (the recipient).
    expect((await s.get(0, { as: ['user_3', 'org_7'] })).status).toBe(200);
  });

  it('refuses a bad chunk count, index or id with 400 fleet.invalid', async () => {
    const s = await setup();
    const cases: [string, Promise<Response>][] = [
      ['index ≥ chunks', s.put(2, bytes(8), { chunks: 2 })],
      ['no chunks header', s.put(0, bytes(8), { chunks: null })],
      ['chunks 0', s.put(0, bytes(8), { chunks: 0 })],
      ['chunks 65', s.put(0, bytes(8), { chunks: 65 })],
      ['chunks text', s.put(0, bytes(8), { chunks: 'two' })],
      ['leading zero', s.put('01', bytes(8))],
      ['negative', s.put('-1', bytes(8))],
      ['uppercase id', s.put(0, bytes(8), { blob: 'A'.repeat(32) })],
      ['short id', s.put(0, bytes(8), { blob: 'abc' })],
      ['empty body', s.put(0, bytes(0))],
    ];
    for (const [what, r] of cases) {
      const res = await r;
      expect([what, res.status]).toEqual([what, 400]);
      expect((await s.error(res)).code).toBe('fleet.invalid');
    }
    expect(s.r2.keys()).toEqual([]);
    expect(s.hubCalls).toEqual([]);
    // Once two chunks are declared, three is a mismatch.
    expect((await s.put(0, bytes(8), { chunks: 2 })).status).toBe(204);
    expect(await s.codeOf(await s.put(1, bytes(8), { chunks: 3 }), 400)).toBe(
      'fleet.invalid',
    );
    // A GET's bad index is invalid too; the DELETE of a bad id as well.
    expect(await s.codeOf(await s.get('x'), 400)).toBe('fleet.invalid');
    expect(await s.codeOf(await s.del({ blob: 'zz' }), 400)).toBe(
      'fleet.invalid',
    );
  });

  it('caps a chunk at 4 MiB + 64 and wants its length', async () => {
    const s = await setup();
    const big = await s.put(0, bytes(8), {
      length: String(BLOB_CHUNK_BYTES + 1),
    });
    expect(await s.codeOf(big, 413)).toBe('fleet.too_large');
    const none = await s.put(0, bytes(8), { length: null });
    expect(await s.codeOf(none, 411)).toBe('fleet.invalid');
    expect(s.r2.keys()).toEqual([]);
    expect(s.hubCalls).toEqual([]);
    // A chunk of exactly the cap goes through (well over the JSON routes' 64 KiB).
    expect((await s.put(0, bytes(BLOB_CHUNK_BYTES))).status).toBe(204);
  });

  it('wants a token with an org, like POST /v1/fleet/request', async () => {
    const s = await setup();
    const no = await s.put(0, bytes(8), { as: null });
    expect(await s.codeOf(no, 401)).toBe('fleet.unauthorized');
    expect(await s.codeOf(await s.get(0, { as: null }), 401)).toBe(
      'fleet.unauthorized',
    );
    expect(await s.codeOf(await s.del({ as: null }), 401)).toBe(
      'fleet.unauthorized',
    );
    const noOrg = await s.put(0, bytes(8), { as: ['user_1'] });
    expect(await s.codeOf(noOrg, 403)).toBe('fleet.no_org');
    expect(s.r2.keys()).toEqual([]);
    expect(s.limited).toEqual([]);
  });

  it('answers 404 / 405 / cloud.config around the routes', async () => {
    const s = await setup();
    expect((await s.call('/v1/fleet/blobs/', { method: 'GET' })).status).toBe(
      404,
    );
    expect(
      (await s.call(`/v1/fleet/blobs/${BLOB}/0/1`, { method: 'GET' })).status,
    ).toBe(404);
    expect(
      (await s.call(`/v1/fleet/blobs/${BLOB}`, { method: 'GET' })).status,
    ).toBe(405);
    expect(
      (await s.call(`/v1/fleet/blobs/${BLOB}/0`, { method: 'DELETE' })).status,
    ).toBe(405);
    expect(
      (await s.call(`/v1/fleet/blobs/${BLOB}/0`, { method: 'POST' })).status,
    ).toBe(405);
    const off = await setup({ bucket: false });
    expect(await off.codeOf(await off.get(0), 500)).toBe('cloud.config');
  });
});

describe('the daily quota', () => {
  it('refuses the chunk that would pass 1 GiB (here: 100 bytes) with 429 fleet.quota', async () => {
    const s = await setup({ quota: { bytes: 100, chunks: 1000 } });
    expect((await s.put(0, bytes(60))).status).toBe(204);
    expect(await s.codeOf(await s.put(1, bytes(60)), 429)).toBe('fleet.quota');
    expect(s.r2.keys('blobs/org_7/')).toEqual([`blobs/org_7/${BLOB}/0`]);
    // Smaller still fits; another user has their own counter.
    expect((await s.put(1, bytes(40))).status).toBe(204);
    expect(
      (await s.put(0, bytes(60), { blob: OTHER, as: ['user_2', 'org_7'] }))
        .status,
    ).toBe(204);
    // Tomorrow it starts over.
    s.advance(24 * 3_600_000);
    expect((await s.put(1, bytes(60))).status).toBe(204);
    expect(s.db.prepare('SELECT day FROM blob_quota').all()).toEqual([
      { day: '2026-11-22' },
    ]);
  });

  it('counts chunks too', async () => {
    const s = await setup({ quota: { bytes: 1 << 30, chunks: 2 } });
    expect((await s.put(0, bytes(8))).status).toBe(204);
    expect((await s.put(1, bytes(8))).status).toBe(204);
    expect(await s.codeOf(await s.put(0, bytes(8), { blob: OTHER }), 429)).toBe(
      'fleet.quota',
    );
  });

  it('runs in the OrgHub, and a purge or a deleted account ends it', async () => {
    const db = new DatabaseSync(':memory:');
    const hub = new OrgHub(doState(db), {
      WORKOS_CLIENT_ID: CLIENT,
      WORKOS_API_BASE: API,
      MCP_KEY_WRAP: MCP_TEST_SECRET,
    });
    const as = (user: string, path: string, body: unknown) =>
      hub.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: {
            [CALLER_HEADER]: JSON.stringify({
              userId: user,
              orgId: 'org_1',
              expMs: 0,
            }),
          },
          body: JSON.stringify(body),
        }),
      );
    expect((await as('u1', QUOTA_PATH, { bytes: 10 })).status).toBe(200);
    expect((await as('u1', QUOTA_PATH, { bytes: -1 })).status).toBe(400);
    expect((await as('u1', QUOTA_PATH, { bytes: 'x' })).status).toBe(400);
    expect((await as('u2', QUOTA_PATH, { bytes: (1 << 30) + 1 })).status).toBe(
      429,
    );
    expect(db.prepare('SELECT user_id, bytes FROM blob_quota').all()).toEqual([
      { user_id: 'u1', bytes: 10 },
    ]);
    expect((await as('u1', PURGE_PATH, { scope: 'user' })).status).toBe(200);
    expect(db.prepare('SELECT * FROM blob_quota').all()).toEqual([]);
    expect((await as('u1', QUOTA_PATH, { bytes: 10 })).status).toBe(401);
  });

  it('a deleted account is refused on the upload too', async () => {
    const s = await setup();
    // The Worker maps the hub's 401 to fleet.unauthorized.
    const gone = await handle(
      new Request(`${ORIGIN}/v1/fleet/blobs/${BLOB}/0`, {
        method: 'PUT',
        headers: {
          [CHUNKS_HEADER]: '1',
          'content-length': '8',
          authorization: `Bearer ${await (await signer()).sign({ sub: 'x' })}`,
        },
        body: bytes(8) as BodyInit,
      }),
      () => ({
        workos: new FakeWorkos(),
        clientId: CLIENT,
        verify: async () => ({
          userId: 'user_gone',
          organizationId: 'org_7',
          permissions: [],
        }),
        blobs: new FakeR2() as unknown as BlobBucket,
        hub: () => ({
          fetch: async () =>
            Response.json(
              { error: { code: 'fleet.unauthorized' } },
              { status: 401 },
            ),
        }),
      }),
    );
    expect(await s.codeOf(gone, 401)).toBe('fleet.unauthorized');
  });
});

describe('logs', () => {
  it('records outcomes and quota hits with the ids hashed for the remote', async () => {
    const s = await setup({ quota: { bytes: 100, chunks: 1000 } });
    const local: LogRecord[] = [];
    const remote: LogRecord[] = [];
    const log = new Logger({
      local: (r) => local.push(r),
      remote: (r) => remote.push(r),
    });
    const put = async (i: number, n: number) =>
      handle(
        new Request(`${ORIGIN}/v1/fleet/blobs/${BLOB}/${i}`, {
          method: 'PUT',
          headers: {
            [CHUNKS_HEADER]: '2',
            'content-length': String(n),
            authorization: `Bearer ${await s.token('user_1', 'org_7')}`,
          },
          body: bytes(n) as BodyInit,
        }),
        () => s.deps,
        [WEB],
        log,
      );
    expect((await put(0, 60)).status).toBe(204);
    expect((await put(1, 60)).status).toBe(429);
    const msgs = local.map((r) => r.msg);
    expect(msgs).toEqual([
      'blob put',
      'http request',
      'quota hit',
      'http request',
    ]);
    expect(local[0]!.attrs).toMatchObject({
      component: 'blobs',
      user_id: 'user_1',
      org_id: 'org_7',
      index: 0,
      chunks: 2,
      bytes: 60,
      first: true,
    });
    expect(local[1]!.attrs).toMatchObject({
      route: '/v1/fleet/blobs/*',
      status: 204,
    });
    expect(local[3]!.attrs).toMatchObject({
      status: 429,
      'error.code': 'fleet.quota',
    });
    // Only the quota hit and the request lines travel, ids hashed.
    expect(remote.map((r) => r.msg)).toEqual([
      'http request',
      'quota hit',
      'http request',
    ]);
    const hit = remote[1]!.attrs;
    expect(hit['user_id']).toMatch(/^h:/);
    expect(hit['org_id']).toMatch(/^h:/);
    expect(JSON.stringify(remote)).not.toContain(BLOB);
  });
});

describe('CORS for the web app on the blob routes', () => {
  it('answers a preflight with PUT and the chunks header, from the web origin only', async () => {
    const s = await setup();
    const pre = await s.call(`/v1/fleet/blobs/${BLOB}/0`, {
      method: 'OPTIONS',
      as: null,
      origin: WEB,
      headers: {
        'access-control-request-method': 'PUT',
        'access-control-request-headers': `authorization, ${CHUNKS_HEADER}`,
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(pre.headers.get('access-control-allow-methods')).toBe(
      'GET, PUT, DELETE, OPTIONS',
    );
    expect(pre.headers.get('access-control-allow-headers')).toBe(
      `Authorization, Content-Type, ${CHUNKS_HEADER}`,
    );
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull();
    const elsewhere = await s.call(`/v1/fleet/blobs/${BLOB}`, {
      method: 'OPTIONS',
      as: null,
      origin: 'https://evil.test',
    });
    expect(elsewhere.status).toBe(204);
    expect(elsewhere.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('lets the web origin read answers and errors', async () => {
    const s = await setup();
    const ok = await s.put(0, bytes(8), { chunks: 1, origin: WEB });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(ok.headers.get('vary')).toBe('Origin');
    const err = await s.call(`/v1/fleet/blobs/${BLOB}/0`, {
      method: 'GET',
      as: null,
      origin: WEB,
    });
    expect(err.status).toBe(401);
    expect(err.headers.get('access-control-allow-origin')).toBe(WEB);
    expect((await s.error(err)).code).toBe('fleet.unauthorized');
  });
});
