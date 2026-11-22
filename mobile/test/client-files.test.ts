/**
 * Files through the fleet client (docs/fleet.md "Files (blobs)"): an
 * attachment sealed for the host's pin and uploaded, carried on a start,
 * send or send_to; `read_file` to the host, its blob fetched, opened with
 * this device's key and deleted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatedPlaintext, openBlob, sealBlob } from '../src/fleet/blob';
import type { BlobStore } from '../src/fleet/blob-store';
import { createFleetClient } from '../src/fleet/client';
import { open } from '../src/fleet/crypto';
import type { FleetClient } from '../src/fleet/types';
import type { BlobRef, RemoteRequest, SignedEnvelope } from '../src/gen/fleet';
import { seedKey } from '../src/keys/ed25519';
import { initialFleet, useFleetState } from '../src/state/fleet';
import {
  CLOUD,
  HOST,
  TIMING,
  device,
  fakeAuth,
  fakePlatform,
  handshake,
  hostKey,
  sealAs,
  waitFor,
} from './fake-hub';

const MY_SEED = new Uint8Array(32).fill(1);
const HOST_SEED = new Uint8Array(32).fill(2);
const myKey = seedKey(MY_SEED);
const keys = { deviceKey: async () => myKey, forget: async () => {} };
const state = () => useFleetState.getState();

/** An in-memory blob store, every call recorded. */
function fakeBlobs() {
  const store = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const blobs: BlobStore = {
    async put(id, i, _chunks, bytes) {
      calls.push(`put ${id}/${i}`);
      store.set(`${id}/${i}`, bytes);
    },
    async get(id, i) {
      calls.push(`get ${id}/${i}`);
      const b = store.get(`${id}/${i}`);
      if (!b) throw new Error('fleet.blob_not_found');
      return b;
    },
    async remove(id) {
      calls.push(`remove ${id}`);
      for (const k of [...store.keys()])
        if (k.startsWith(`${id}/`)) store.delete(k);
    },
    async upload(ref, chunks, onProgress) {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      let done = 0;
      onProgress?.(0, total);
      for (let i = 0; i < chunks.length; i++) {
        await this.put(ref.blob_id, i, ref.chunks, chunks[i]!);
        done += chunks[i]!.length;
        onProgress?.(done, total);
      }
    },
    async download(ref, onProgress) {
      const out: Uint8Array[] = [];
      for (let i = 0; i < ref.chunks; i++)
        out.push(await this.get(ref.blob_id, i));
      onProgress?.(1, 1);
      return out;
    },
  };
  return { blobs, store, calls };
}

let clients: FleetClient[] = [];

async function connected() {
  const hub = fakePlatform();
  const account = fakeAuth();
  const files = fakeBlobs();
  let n = 0;
  const client = createFleetClient(account.auth, keys, {
    platform: hub.platform,
    cloudUrl: CLOUD,
    timing: TIMING,
    random: () => 0.5,
    randomBytes: (k) => new Uint8Array(k).fill(++n),
    blobs: files.blobs,
  });
  clients.push(client);
  await client.start();
  const sock = await handshake(hub, [device(HOST, hostKey)]);
  await waitFor(() => state().devices.length === 1, 'devices');
  await client.trust(HOST, hostKey.publicKey);
  return { hub, client, sock, files };
}

function lastRequest(sock: {
  of: (t: 'request') => { envelope: SignedEnvelope }[];
}) {
  const reqs = sock.of('request');
  const body = open(
    reqs[reqs.length - 1]!.envelope,
    myKey.publicKey,
    'request',
  );
  expect(body).not.toBeNull();
  return body as RemoteRequest;
}

const reply = (req: RemoteRequest, outcome: object) =>
  sealAs(
    {
      req_id: req.req_id,
      origin_device: req.origin_device,
      target_device: HOST,
      outcome,
    },
    HOST,
    hostKey,
    'reply',
  );

/** A reference the host could have made for this device. */
function hostSealed(
  bytes: Uint8Array,
  name = 'screen.png',
  mime = 'image/png',
) {
  return sealBlob(myKey.publicKey, bytes, name, mime);
}

beforeEach(() => {
  useFleetState.setState(initialFleet, true);
});

afterEach(() => {
  clients.forEach((c) => c.stop());
  clients = [];
});

describe('attachments (phone ─▶ computer)', () => {
  it('seals a file for the host pin, uploads it with progress, and the host opens it', async () => {
    const { client, files } = await connected();
    const bytes = generatedPlaintext(4 * 1024 * 1024 + 5);
    const progress: number[] = [];
    const ref = await client.uploadAttachment(
      HOST,
      { bytes, name: 'shots/screen.png', mime: 'image/png' },
      (f) => progress.push(f),
    );
    expect(ref.name).toBe('screen.png');
    expect(ref.mime).toBe('image/png');
    expect(ref.size).toBe(bytes.length);
    expect(ref.chunks).toBe(2);
    expect(files.calls).toEqual([
      `put ${ref.blob_id}/0`,
      `put ${ref.blob_id}/1`,
    ]);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    // The host (its seed) reads it; a stranger can't.
    const chunks = [0, 1].map((i) => files.store.get(`${ref.blob_id}/${i}`)!);
    expect(openBlob(HOST_SEED, ref, chunks)).toEqual(bytes);
    expect(() => openBlob(MY_SEED, ref, chunks)).toThrow();
  });

  it('refuses an untrusted host and a file over 20 MiB before uploading anything', async () => {
    const { client, files } = await connected();
    const small = {
      bytes: new Uint8Array(3),
      name: 'a.txt',
      mime: 'text/plain',
    };
    await expect(
      client.uploadAttachment(
        'dev_00000000-0000-4000-8000-0000000000c3',
        small,
      ),
    ).rejects.toThrow(/trusted/);
    await expect(
      client.uploadAttachment(HOST, {
        bytes: new Uint8Array(20 * 1024 * 1024 + 1),
        name: 'big.bin',
        mime: '',
      }),
    ).rejects.toThrow(/20 MiB/);
    expect(files.calls).toEqual([]);
  });

  it('deletes a blob taken back', async () => {
    const { client, files } = await connected();
    const ref = await client.uploadAttachment(HOST, {
      bytes: new Uint8Array(3),
      name: 'a.txt',
      mime: 'text/plain',
    });
    await client.deleteBlob(ref.blob_id);
    expect(files.store.size).toBe(0);
    await expect(client.deleteBlob('not-an-id')).rejects.toThrow(/blob id/);
  });

  it('puts the references on a start, a send and a send_to', async () => {
    const { client, sock } = await connected();
    const a = await client.uploadAttachment(HOST, {
      bytes: new Uint8Array(3),
      name: 'a.txt',
      mime: 'text/plain',
    });
    const b = await client.uploadAttachment(HOST, {
      bytes: new Uint8Array(4),
      name: 'b.png',
      mime: 'image/png',
    });
    void client
      .startSpace({
        deviceId: HOST,
        projectId: 'p1',
        goal: 'look at these',
        mode: 'edit',
        attachments: [a, b],
      })
      .catch(() => {});
    await waitFor(() => sock.of('request').length === 1, 'start');
    const start = lastRequest(sock);
    expect(start.op.op).toBe('start_space');
    expect((start.op as { attachments: BlobRef[] }).attachments).toEqual([
      a,
      b,
    ]);
    const space = (start.op as { space: string }).space;

    void client.send(space, 'and this', null, {}, [a]).catch(() => {});
    await waitFor(() => sock.of('request').length === 2, 'send');
    const send = lastRequest(sock);
    expect(send.op).toEqual({
      op: 'send',
      space,
      text: 'and this',
      mode: null,
      agent: null,
      model: null,
      effort: null,
      attachments: [a],
    });

    void client
      .sendTo(HOST, 'a1b2c3d4e5f6', 'for the child', [b])
      .catch(() => {});
    await waitFor(() => sock.of('request').length === 3, 'send_to');
    expect(lastRequest(sock).op).toEqual({
      op: 'send_to',
      space: 'a1b2c3d4e5f6',
      message: 'for the child',
      attachments: [b],
    });
  });

  it('refuses what the host would: over 10, twice, over 20 MiB, malformed', async () => {
    const { client, sock } = await connected();
    const ref = (i: number): BlobRef => ({
      blob_id: i.toString(16).padStart(32, '0'),
      name: `f${i}.txt`,
      mime: 'text/plain',
      size: 3,
      chunks: 1,
      sha256: '0'.repeat(64),
      eph_pk: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      nonce_prefix: 'AAAAAAAAAAAAAAAAAAAAAA==',
    });
    const many = Array.from({ length: 11 }, (_, i) => ref(i));
    await expect(
      client.sendTo(HOST, 'a1b2c3d4e5f6', 'x', many),
    ).rejects.toThrow(/at most 10/);
    await expect(
      client.sendTo(HOST, 'a1b2c3d4e5f6', 'x', [ref(1), ref(1)]),
    ).rejects.toThrow(/twice/);
    await expect(
      client.sendTo(HOST, 'a1b2c3d4e5f6', 'x', [
        { ...ref(1), size: 20 * 1024 * 1024 + 1, chunks: 6 },
      ]),
    ).rejects.toThrow(/20 MiB/);
    await expect(
      client.sendTo(HOST, 'a1b2c3d4e5f6', 'x', [
        { ...ref(1), blob_id: 'nope' },
      ]),
    ).rejects.toThrow(/bad blob_id/);
    expect(sock.of('request')).toHaveLength(0);
  });
});

describe('read_file (computer ─▶ phone)', () => {
  const SPACE = 'rs_0123456789abcdef0123456789abcdef';

  it('signs a read_file with the path and a capped max_bytes, takes a valid blob back', async () => {
    const { client, sock } = await connected();
    const bytes = generatedPlaintext(340);
    const { ref } = hostSealed(bytes);
    const read = client.readFile(HOST, SPACE, '.context/screen.png', 10 ** 12);
    await waitFor(() => sock.of('request').length === 1, 'request');
    const req = lastRequest(sock);
    expect(req.target_device).toBe(HOST);
    expect(req.op).toEqual({
      op: 'read_file',
      space: SPACE,
      path: '.context/screen.png',
      max_bytes: 50 * 1024 * 1024,
    });
    sock.deliver({
      type: 'reply',
      envelope: await reply(req, { outcome: 'ok', value: { blob: ref } }),
    });
    expect(await read).toEqual(ref);
  });

  it('refuses a bad path, a refusal, a non-blob answer and a blob over what was asked', async () => {
    const { client, sock } = await connected();
    await expect(client.readFile(HOST, SPACE, '')).rejects.toThrow(/file path/);
    await expect(client.readFile(HOST, SPACE, 'a\0b')).rejects.toThrow(
      /file path/,
    );
    await expect(
      client.readFile(HOST, SPACE, 'x'.repeat(1025)),
    ).rejects.toThrow(/file path/);
    await expect(client.readFile(HOST, 'bad space!', 'a')).rejects.toThrow(
      /space id/,
    );

    const refused = client.readFile(HOST, SPACE, 'secret.txt');
    await waitFor(() => sock.of('request').length === 1, 'request');
    sock.deliver({
      type: 'reply',
      envelope: await reply(lastRequest(sock), {
        outcome: 'err',
        code: 'fleet.denied',
        message: 'outside the worktree',
      }),
    });
    await expect(refused).rejects.toThrow(/fleet.denied/);

    const junk = client.readFile(HOST, SPACE, 'a.txt');
    await waitFor(() => sock.of('request').length === 2, 'request');
    sock.deliver({
      type: 'reply',
      envelope: await reply(lastRequest(sock), {
        outcome: 'ok',
        value: { blob: { blob_id: 'x' } },
      }),
    });
    await expect(junk).rejects.toThrow(/wasn't a file/);

    const { ref } = hostSealed(generatedPlaintext(2000));
    const over = client.readFile(HOST, SPACE, 'a.txt', 1000);
    await waitFor(() => sock.of('request').length === 3, 'request');
    const req = lastRequest(sock);
    expect((req.op as { max_bytes: number }).max_bytes).toBe(1000);
    sock.deliver({
      type: 'reply',
      envelope: await reply(req, { outcome: 'ok', value: { blob: ref } }),
    });
    await expect(over).rejects.toThrow(/larger/);
  });

  it('fetches the chunks, opens them with this key, deletes the blob', async () => {
    const { client, files } = await connected();
    const bytes = generatedPlaintext(4 * 1024 * 1024 + 7);
    const { ref, chunks } = hostSealed(
      bytes,
      'big.bin',
      'application/octet-stream',
    );
    chunks.forEach((c, i) => files.store.set(`${ref.blob_id}/${i}`, c));
    expect(await client.canOpenBlobs()).toBe(true);
    const progress: number[] = [];
    const got = await client.fetchBlob(ref, (f) => progress.push(f));
    expect(got).toEqual(bytes);
    expect(progress.at(-1)).toBe(1);
    expect(files.calls).toEqual([
      `get ${ref.blob_id}/0`,
      `get ${ref.blob_id}/1`,
      `remove ${ref.blob_id}`,
    ]);
    expect(files.store.size).toBe(0);
  });

  it('a tampered or foreign blob opens nothing, and is still deleted', async () => {
    const { client, files } = await connected();
    const { ref, chunks } = hostSealed(generatedPlaintext(10));
    const flipped = Uint8Array.from(chunks[0]!);
    flipped[3]! ^= 0x10;
    files.store.set(`${ref.blob_id}/0`, flipped);
    await expect(client.fetchBlob(ref)).rejects.toThrow(/chunk 0/);
    expect(files.store.size).toBe(0);

    // Sealed for the host, not for this device.
    const foreign = sealBlob(
      hostKey.publicKey,
      generatedPlaintext(10),
      'x',
      '',
    );
    files.store.set(`${foreign.ref.blob_id}/0`, foreign.chunks[0]!);
    await expect(client.fetchBlob(foreign.ref)).rejects.toThrow(/chunk 0/);
    await expect(client.fetchBlob({ ...ref, chunks: 0 })).rejects.toThrow(
      /bad chunks/,
    );
  });

  it('a key that cannot open blobs says so', async () => {
    const hub = fakePlatform();
    const webKey = { publicKey: myKey.publicKey, sign: myKey.sign };
    const client = createFleetClient(
      fakeAuth().auth,
      {
        deviceKey: async () => webKey,
        forget: async () => {},
      },
      {
        platform: hub.platform,
        cloudUrl: CLOUD,
        timing: TIMING,
        blobs: fakeBlobs().blobs,
      },
    );
    clients.push(client);
    expect(await client.canOpenBlobs()).toBe(false);
    const { ref } = hostSealed(generatedPlaintext(10));
    await expect(client.fetchBlob(ref)).rejects.toThrow(/can't open files/);
  });
});
