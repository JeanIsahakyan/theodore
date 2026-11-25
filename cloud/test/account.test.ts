// DELETE /v1/account: the caller's rows purged from every org hub they're
// in (another member's kept), the personal org's hub emptied, MCP grants
// revoked, then the personal org and the WorkOS user deleted, last. A
// retry finishes what a failed step left. Hubs are Harnesses (node:sqlite,
// fake sockets) behind the same purge handler the OrgHub runs.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Delegation, RemoteSpaceEvent } from '../src/gen/fleet';
import { verifyAccessToken } from '../src/auth';
import { GONE_USER_MS } from '../src/fleet/limits';
import { OrgHub, readCaller } from '../src/fleet/org-hub';
import {
  answerPurge,
  CALLER_HEADER,
  PURGE_PATH,
  purgeInHub,
  type HubFor,
} from '../src/fleet/route';
import { DATA_TABLES } from '../src/fleet/store';
import { handle, type Deps } from '../src/index';
import { MCP_TABLES } from '../src/mcp/store';
import { WorkosError } from '../src/workos';
import { FakeWorkos } from './fake-workos';
import {
  FakeConn,
  Harness,
  MCP_TEST_SECRET,
  startSpace,
  type Device,
} from './fleet-harness';
import { API, CLIENT, signer } from './keys';
import { doState, FakeKv, FakeR2 } from './workers-fakes';

const ORIGIN = 'https://cloud.test';
const WEB = 'https://web.test';
const ALICE = 'user_alice';
const BOB = 'user_bob';
const TABLES = [...DATA_TABLES, ...MCP_TABLES];

/** A Harness as the Worker reaches a hub: only the purge path. */
function harnessHub(h: Harness, o: { fail?: boolean } = {}) {
  return {
    fetch: async (req: Request) => {
      if (o.fail || new URL(req.url).pathname !== PURGE_PATH) {
        return new Response('down', { status: 500 });
      }
      const caller = readCaller(req.headers.get(CALLER_HEADER))!;
      return answerPurge(
        h.hub,
        { user: (u) => h.mcp!.forget(u), all: () => h.mcp!.store.purgeAll() },
        caller,
        req,
      );
    },
  };
}

async function delegateTo(origin: Device, delegate: Device) {
  const body: Delegation = {
    origin_device: origin.id!,
    delegate_device: delegate.id!,
    issued_at_ms: origin.h.now,
    expires_at_ms: 0,
    revoke: false,
  };
  await origin.send({
    type: 'delegate',
    envelope: await origin.seal('delegate', body),
  });
}

interface Seeded {
  devices: Device[];
  /** Every id of the user's that rows may carry. */
  ids: string[];
}

/**
 * One user's fleet in `h`, a row in every table: two computers and a phone
 * online, a space (events, a mirror, a question, a subscription), a push
 * token, a delegation, a request pending, the MCP device online; a held
 * reply, a confirm and the MCP device's own tables seeded directly.
 */
async function seed(h: Harness, user: string, tag: string): Promise<Seeded> {
  const mac1 = await h.device(user, `${tag}-mac1`);
  const mac2 = await h.device(user, `${tag}-mac2`);
  const phone = await h.phone(user, `${tag}-phone`);
  for (const d of [mac1, mac2, phone]) await d.connect();
  const space = `rs_${tag}`;
  await startSpace(mac1, mac2, space);
  await mac2.emit(space, 1, {
    kind: 'started',
    host_device: mac2.id!,
    origin_device: mac1.id!,
    project_id: 'p1',
    project_name: 'theodore',
    name: 'Fix login',
    branch: 'b',
    mode: 'edit',
    parent: null,
    depth: 0,
  });
  await mac2.emit(space, 2, {
    kind: 'mirror',
    model: 'chat_message',
    id: `m_${tag}`,
    data: { text: 'hi' },
  } as RemoteSpaceEvent);
  await phone.send({
    type: 'register_push',
    provider: 'expo',
    token: `ExponentPushToken[${tag}]`,
  });
  await delegateTo(mac1, phone);
  await phone.send({ type: 'subscribe', space, since: 0 });
  await mac2.raise({
    ask_id: `ask_${tag}`,
    space,
    host_device: mac2.id!,
    from: 'mac2 · Fix login',
    questions: [{ question: 'Which?', options: ['a', 'b'], multi: false }],
  });
  await mac1.request(mac2.id!, { op: 'stop', space });
  await h.mcp!.online({ userId: user, orgId: 'org_1' });

  const mcpSpace = `rs_mcp_${tag}`;
  const now = h.now;
  const run = (q: string, ...b: (string | number | null)[]) =>
    h.db.prepare(q).all(...b);
  run(
    'INSERT INTO replies (req_id, origin_device, message, created_ms) VALUES (?, ?, ?, ?)',
    `rp_${tag}`,
    mac1.id!,
    '{}',
    now,
  );
  run(
    `INSERT INTO confirms (confirm_id, user_id, host_device, envelope, expires_at_ms, created_ms)
     VALUES (?, ?, ?, '{}', ?, ?)`,
    `cf_${tag}`,
    user,
    mac2.id!,
    now + 60_000,
    now,
  );
  run(
    'INSERT INTO mcp_pins (user_id, device_id, public_key, name, pinned_ms) VALUES (?, ?, ?, ?, ?)',
    user,
    mac1.id!,
    mac1.publicKey,
    `${tag}-mac1`,
    now,
  );
  run('INSERT INTO mcp_inbox (user_id, frame) VALUES (?, ?)', user, '{}');
  run(
    `INSERT INTO mcp_requests (req_id, user_id, target_device, target_key, op, space, created_ms)
     VALUES (?, ?, ?, ?, 'start_space', ?, ?)`,
    `mr_${tag}`,
    user,
    mac1.id!,
    mac1.publicKey,
    mcpSpace,
    now,
  );
  run(
    `INSERT INTO mcp_spaces (space, user_id, host_device, host_name, project_id, mode, status, created_ms, updated_ms)
     VALUES (?, ?, ?, 'mac', 'p1', 'edit', 'running', ?, ?)`,
    mcpSpace,
    user,
    mac1.id!,
    now,
    now,
  );
  run(
    "INSERT INTO mcp_lines (space, seq, kind, text) VALUES (?, 1, 'reply', 'done')",
    mcpSpace,
  );
  run(
    `INSERT INTO mcp_sub_spaces (space, id, parent, title, status, mode, done, seq)
     VALUES (?, 'sub_1', ?, 'Sub', 'running', 'edit', 0, 1)`,
    mcpSpace,
    mcpSpace,
  );
  return {
    devices: [mac1, mac2, phone],
    ids: [user, mac1.id!, mac2.id!, phone.id!, space, mcpSpace],
  };
}

/** Per table: rows that carry any of `ids`. */
function mentions(h: Harness, ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    out[t] = h.db
      .prepare(`SELECT * FROM ${t}`)
      .all()
      .filter((r) => ids.some((id) => JSON.stringify(r).includes(id))).length;
  }
  return out;
}

const rowCount = (h: Harness, t: string) =>
  (h.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).all()[0] as { n: number }).n;

describe('purge in a hub', () => {
  it('drops every row of the user, closes its connections, keeps the other member’s', async () => {
    const h = new Harness(new DatabaseSync(':memory:'), { mcp: true });
    const alice = await seed(h, ALICE, 'alice');
    const bob = await seed(h, BOB, 'bob');
    const before = { alice: mentions(h, alice.ids), bob: mentions(h, bob.ids) };
    for (const t of TABLES) {
      expect([t, before.alice[t]! > 0]).toEqual([t, true]);
      expect([t, before.bob[t]! > 0]).toEqual([t, true]);
    }

    const hubFor: HubFor = () => harnessHub(h);
    await purgeInHub(hubFor, ORIGIN, ALICE, 'org_1', 'user');

    const after = mentions(h, alice.ids);
    for (const t of TABLES) expect([t, after[t]]).toEqual([t, 0]);
    expect(mentions(h, bob.ids)).toEqual(before.bob);
    for (const d of alice.devices) {
      expect(d.conn.open).toBe(false);
      expect(d.conn.closedWith).toEqual({
        code: 4001,
        reason: 'fleet.unauthorized',
      });
    }
    for (const d of bob.devices) expect(d.conn.open).toBe(true);
    expect(h.mcp!.conns(ALICE)).toEqual([]);
    expect(h.mcp!.conns(BOB)).toHaveLength(1);

    // Idempotent.
    await purgeInHub(hubFor, ORIGIN, ALICE, 'org_1', 'user');
    expect(mentions(h, bob.ids)).toEqual(before.bob);
  });

  it('refuses the deleted user for a day, then forgets it', async () => {
    const h = new Harness(new DatabaseSync(':memory:'), { mcp: true });
    await seed(h, ALICE, 'alice');
    await purgeInHub(() => harnessHub(h), ORIGIN, ALICE, 'org_1', 'user');
    expect(h.hub.isGone(ALICE)).toBe(true);
    expect(h.hub.isGone(BOB)).toBe(false);

    const conn = new FakeConn(ALICE);
    h.conns.push(conn);
    await h.hub.open(conn, {
      userId: ALICE,
      orgId: 'org_1',
      expMs: h.now + 3_600_000,
    });
    expect(conn.sent.map((m) => m.type)).toEqual(['error']);
    expect(conn.closedWith?.code).toBe(4001);
    expect(rowCount(h, 'devices')).toBe(0);

    await h.tick(GONE_USER_MS);
    expect(h.hub.isGone(ALICE)).toBe(false);
    expect(rowCount(h, 'devices')).toBe(0);
    expect(h.db.prepare('SELECT * FROM gone_users').all()).toEqual([]);
    const later = await h.device(ALICE, 'mac');
    await later.connect();
    expect(rowCount(h, 'devices')).toBe(1);
  });

  it('empties the whole hub for a personal org', async () => {
    const h = new Harness(new DatabaseSync(':memory:'), { mcp: true });
    const alice = await seed(h, ALICE, 'alice');
    const other = await seed(h, BOB, 'bob');
    await purgeInHub(() => harnessHub(h), ORIGIN, ALICE, 'org_p', 'org');
    for (const t of TABLES) expect([t, rowCount(h, t)]).toEqual([t, 0]);
    for (const d of [...alice.devices, ...other.devices]) {
      expect(d.conn.closedWith?.code).toBe(4001);
    }
    expect(h.hub.isGone(ALICE)).toBe(true);
  });

  it('runs in the OrgHub: purge, then the user is refused on every path', async () => {
    const hub = new OrgHub(doState(new DatabaseSync(':memory:')), {
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
    expect((await as(ALICE, PURGE_PATH, { scope: 'nope' })).status).toBe(400);
    expect((await as(ALICE, PURGE_PATH, { scope: 'user' })).status).toBe(200);
    for (const path of ['/v1/fleet/request', '/mcp/call', '/mcp/enable']) {
      const r = await as(ALICE, path, { name: 'devices_list' });
      expect([path, r.status]).toEqual([path, 401]);
    }
    const bob = await as(BOB, '/mcp/enable', {});
    expect(bob.status).toBe(200);
    // A retry of the purge still answers.
    expect((await as(ALICE, PURGE_PATH, { scope: 'user' })).status).toBe(200);
  });
});

describe('DELETE /v1/account', async () => {
  const { keys, sign } = await signer();

  async function setup(
    o: { failHub?: boolean; forgetPerson?: (id: string) => Promise<void> } = {},
  ) {
    const workos = new FakeWorkos();
    workos.orgs.push(
      {
        id: 'org_personal',
        name: 'Personal',
        external_id: `personal:${ALICE}`,
      },
      { id: 'org_team', name: 'Team' },
      { id: 'org_solo', name: 'Side project' },
      { id: 'org_bob', name: 'Personal', external_id: `personal:${BOB}` },
    );
    workos.addMembership(ALICE, 'org_personal');
    workos.addMembership(ALICE, 'org_team', 'member');
    workos.addMembership(ALICE, 'org_solo');
    workos.addMembership(BOB, 'org_team');
    workos.addMembership(BOB, 'org_bob');

    const team = new Harness(new DatabaseSync(':memory:'), { mcp: true });
    const personal = new Harness(new DatabaseSync(':memory:'), { mcp: true });
    const solo = new Harness(new DatabaseSync(':memory:'), { mcp: true });
    const bobs = new Harness(new DatabaseSync(':memory:'), { mcp: true });
    const alice = await seed(team, ALICE, 'alice');
    const bob = await seed(team, BOB, 'bob');
    await seed(personal, ALICE, 'alice');
    await seed(solo, ALICE, 'alice');
    await seed(bobs, BOB, 'bob');
    const hubs: Record<string, Harness> = {
      org_team: team,
      org_personal: personal,
      org_solo: solo,
      org_bob: bobs,
    };

    // A blob chunk per org and uploader, with its owner mark.
    const r2 = new FakeR2();
    const blob = async (org: string, uploader: string, id: string) => {
      const customMetadata = { uploader, org_id: org, chunks: '1' };
      await r2.put(`blobs/_owner/${id}`, '', { customMetadata });
      await r2.put(`blobs/${org}/${id}/0`, 'sealed', { customMetadata });
    };
    await blob('org_personal', ALICE, 'b1');
    await blob('org_solo', ALICE, 'b2');
    await blob('org_team', ALICE, 'b3');
    await blob('org_team', BOB, 'b4');
    await blob('org_bob', BOB, 'b5');

    const kv = new FakeKv();
    const grant = (user: string, id: string) =>
      kv.put(
        `grant:${user}:${id}`,
        JSON.stringify({
          id,
          clientId: 'client_mcp',
          userId: user,
          scope: ['fleet'],
          metadata: {},
          createdAt: 0,
        }),
      );
    await grant(ALICE, 'g1');
    await grant(ALICE, 'g2');
    await kv.put(`token:${ALICE}:g1:t1`, '{}');
    await kv.put(`token:${ALICE}:g2:t2`, '{}');
    await grant(BOB, 'g3');
    await kv.put(`token:${BOB}:g3:t3`, '{}');

    const deps: Deps = {
      workos,
      clientId: CLIENT,
      apiBase: API,
      verify: (t) =>
        verifyAccessToken(t, { apiBase: API, clientId: CLIENT, keys }),
      hub: (org) => harnessHub(hubs[org]!, { fail: o.failHub }),
      oauthKv: kv as unknown as KVNamespace,
      blobs: r2 as unknown as R2Bucket,
      forgetPerson: o.forgetPerson,
    };
    const call = (token?: string, init: RequestInit = {}) =>
      handle(
        new Request(`${ORIGIN}/v1/account`, {
          method: 'DELETE',
          ...init,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(init.headers as Record<string, string> | undefined),
          },
        }),
        () => deps,
        [WEB],
      );
    return { workos, team, personal, solo, bobs, alice, bob, kv, r2, call };
  }

  const code = async (r: Response) =>
    ((await r.json()) as { error: { code: string } }).error.code;

  it('refuses a request without a valid token', async () => {
    const s = await setup();
    const none = await s.call();
    expect(none.status).toBe(401);
    expect(await code(none)).toBe('cloud.unauthorized');
    const forged = await (await signer()).sign({ sub: ALICE });
    expect((await s.call(forged)).status).toBe(401);
    expect(s.workos.calls).toEqual([]);
    expect(s.kv.m.size).toBe(6);
  });

  it('deletes the account: hubs purged, grants revoked, personal org then user deleted', async () => {
    const s = await setup();
    const bobBefore = mentions(s.team, s.bob.ids);
    const bobsOwn = TABLES.map((t) => rowCount(s.bobs, t));

    const r = await s.call(await sign({ sub: ALICE }));
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');

    // The team hub: Alice's rows gone, Bob's untouched.
    const left = mentions(s.team, s.alice.ids);
    for (const t of TABLES) expect([t, left[t]]).toEqual([t, 0]);
    expect(mentions(s.team, s.bob.ids)).toEqual(bobBefore);
    // Her personal org's hub and the org only she was in: empty. Bob's own
    // org: never touched.
    for (const t of TABLES) {
      expect([t, rowCount(s.personal, t)]).toEqual([t, 0]);
      expect([t, rowCount(s.solo, t)]).toEqual([t, 0]);
    }
    expect(TABLES.map((t) => rowCount(s.bobs, t))).toEqual(bobsOwn);

    // MCP grants and their tokens: hers gone, his kept.
    expect([...s.kv.m.keys()].sort()).toEqual([
      `grant:${BOB}:g3`,
      `token:${BOB}:g3:t3`,
    ]);

    // Blobs: hers gone with their owner marks, Bob's kept, in the team too.
    expect(s.r2.keys()).toEqual([
      'blobs/_owner/b4',
      'blobs/_owner/b5',
      'blobs/org_bob/b5/0',
      'blobs/org_team/b4/0',
    ]);

    // WorkOS: the personal org and the org only she was in, then the user,
    // last; the team org (Bob is in it) stays.
    const deletes = s.workos.calls.filter((c) => c.startsWith('delete'));
    expect(deletes).toEqual([
      'deleteOrg org_personal',
      'deleteOrg org_solo',
      `deleteUser ${ALICE}`,
    ]);
    expect(s.workos.calls.at(-1)).toBe(`deleteUser ${ALICE}`);
    expect(s.workos.orgs.map((o) => o.id)).toEqual(['org_team', 'org_bob']);
    expect(
      s.workos.memberships_.map((m) => [m.user_id, m.organization_id]),
    ).toEqual([
      [BOB, 'org_team'],
      [BOB, 'org_bob'],
    ]);
  });

  it('is idempotent: a retry after success is a 204 that does nothing', async () => {
    const s = await setup();
    const token = await sign({ sub: ALICE });
    expect((await s.call(token)).status).toBe(204);
    s.workos.calls = [];
    const again = await s.call(token);
    expect(again.status).toBe(204);
    expect(s.workos.calls).toEqual([`getUser ${ALICE}`]);
  });

  it('a failed last step leaves a state the retry finishes', async () => {
    const s = await setup();
    const token = await sign({ sub: ALICE });
    s.workos.failDeleteOnce = {
      user: new WorkosError(500, undefined, 'WorkOS down'),
    };
    const failed = await s.call(token);
    expect(failed.status).toBe(502);
    expect(await code(failed)).toBe('cloud.workos');
    expect(s.workos.deletedUsers.has(ALICE)).toBe(false);

    s.workos.calls = [];
    expect((await s.call(token)).status).toBe(204);
    expect(s.workos.deletedUsers.has(ALICE)).toBe(true);
    // The personal org was already gone: nothing to find, nothing deleted twice.
    expect(s.workos.calls.filter((c) => c.startsWith('delete'))).toEqual([
      `deleteUser ${ALICE}`,
    ]);
  });

  it('deletes the PostHog person before the user, by the user id', async () => {
    const forgotten: string[] = [];
    const s = await setup({
      forgetPerson: async (id) => {
        forgotten.push(id);
        expect(s.workos.deletedUsers.has(ALICE)).toBe(false);
      },
    });
    expect((await s.call(await sign({ sub: ALICE }))).status).toBe(204);
    expect(forgotten).toEqual([ALICE]);
  });

  it('a PostHog failure never blocks the deletion', async () => {
    const s = await setup({
      forgetPerson: async () => {
        throw new Error('posthog down');
      },
    });
    expect((await s.call(await sign({ sub: ALICE }))).status).toBe(204);
    expect(s.workos.deletedUsers.has(ALICE)).toBe(true);
  });

  it('a hub that fails stops before anything is deleted in WorkOS', async () => {
    const s = await setup({ failHub: true });
    const r = await s.call(await sign({ sub: ALICE }));
    expect(r.status).toBe(500);
    expect(await code(r)).toBe('cloud.internal');
    expect(s.workos.calls.filter((c) => c.startsWith('delete'))).toEqual([]);
  });

  it('answers the web app with CORS, DELETE allowed', async () => {
    const s = await setup();
    const pre = await s.call(undefined, {
      method: 'OPTIONS',
      headers: { origin: WEB },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(pre.headers.get('access-control-allow-methods')).toContain('DELETE');
    const r = await s.call(await sign({ sub: ALICE }), {
      headers: { origin: WEB },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe(WEB);
  });

  it('answers 405 for any other method', async () => {
    const s = await setup();
    const r = await s.call(await sign({ sub: ALICE }), { method: 'GET' });
    expect(r.status).toBe(405);
  });
});
