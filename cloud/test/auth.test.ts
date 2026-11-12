import { describe, expect, it } from 'vitest';
import { bearer, issuerAccepted, verifyAccessToken } from '../src/auth';
import { CloudError } from '../src/errors';
import { API, CLIENT, signer } from './keys';

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => (e instanceof CloudError ? e.code : String(e)),
  );

describe('verifyAccessToken', async () => {
  const { keys, sign } = await signer();
  const verify = (t: string) =>
    verifyAccessToken(t, { apiBase: API, clientId: CLIENT, keys });

  it('accepts a valid token and reads its claims', async () => {
    const t = await sign({
      sub: 'user_1',
      sid: 'session_1',
      org_id: 'org_1',
      role: 'admin',
      permissions: ['fleet:run', 7],
    });
    expect(await verify(t)).toEqual({
      userId: 'user_1',
      sessionId: 'session_1',
      organizationId: 'org_1',
      role: 'admin',
      permissions: ['fleet:run'],
    });
  });

  it('accepts the bare api issuer', async () => {
    const t = await sign({ sub: 'user_1', iss: API });
    expect((await verify(t)).organizationId).toBeUndefined();
  });

  it('rejects an expired token beyond the leeway', async () => {
    const t = await sign(
      { sub: 'user_1' },
      { exp: Math.floor(Date.now() / 1000) - 120 },
    );
    expect(await code(verify(t))).toBe('cloud.unauthorized');
  });

  it('accepts a token expired within the 60 s leeway', async () => {
    const t = await sign(
      { sub: 'user_1' },
      { exp: Math.floor(Date.now() / 1000) - 30 },
    );
    expect(await code(verify(t))).toBe('ok');
  });

  it('rejects a token signed by another key', async () => {
    const other = await signer();
    const t = await other.sign({ sub: 'user_1' });
    expect(await code(verify(t))).toBe('cloud.unauthorized');
  });

  it('rejects another issuer', async () => {
    const t = await sign({ sub: 'user_1', iss: 'https://evil.test' });
    expect(await code(verify(t))).toBe('cloud.unauthorized');
  });

  it('rejects a client_id that is neither ours nor the issuer’s', async () => {
    const t = await sign({ sub: 'user_1', client_id: 'client_OTHER' });
    expect(await code(verify(t))).toBe('cloud.unauthorized');
  });

  it('rejects a token without sub', async () => {
    const t = await sign({});
    expect(await code(verify(t))).toBe('cloud.unauthorized');
  });

  it('rejects garbage', async () => {
    expect(await code(verify('not.a.jwt'))).toBe('cloud.unauthorized');
  });

  it('answers 503 when the key set can’t be fetched', async () => {
    const t = await sign({ sub: 'user_1' });
    const down = async () => {
      throw new TypeError('fetch failed');
    };
    const e = await verifyAccessToken(t, {
      apiBase: API,
      clientId: CLIENT,
      keys: down,
    }).catch((e) => e);
    expect(e).toBeInstanceOf(CloudError);
    expect((e as CloudError).status).toBe(503);
  });
});

describe('issuerAccepted', () => {
  it.each([
    [`${API}`, true],
    [`${API}/`, true],
    [`${API}/user_management/client_X`, true],
    [`${API}/user_management/client_X/more`, false],
    [`${API}/user_management/notaclient`, false],
    ['https://api.workos.test.evil', false],
  ])('%s → %s', (iss, ok) => expect(issuerAccepted(iss, API)).toBe(ok));
});

describe('bearer', () => {
  const req = (h?: string) =>
    new Request('https://x/', { headers: h ? { authorization: h } : {} });
  it('reads the token', () =>
    expect(bearer(req('Bearer a.b.c'))).toBe('a.b.c'));
  it.each([undefined, 'Basic abc', 'Bearer ', 'Bearer a b'])(
    'rejects %s',
    (h) => expect(() => bearer(req(h))).toThrow(CloudError),
  );
});
