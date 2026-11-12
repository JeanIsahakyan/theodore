import { describe, expect, it } from 'vitest';
import { WorkosClient, WorkosError } from '../src/workos';

function recorder(responses: Array<[number, unknown]>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const [status, body] = responses.shift() ?? [500, {}];
    return new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      { status },
    );
  };
  return {
    calls,
    client: new WorkosClient('sk_test_x', 'https://api.workos.test/', fetchFn),
  };
}

describe('WorkosClient', () => {
  it('sends the key and reads an org by external id', async () => {
    const { calls, client } = recorder([[200, { id: 'org_1', name: 'n' }]]);
    expect(await client.organizationByExternalId('personal:user 1')).toEqual({
      id: 'org_1',
      name: 'n',
    });
    expect(calls[0]!.url).toBe(
      'https://api.workos.test/organizations/external_id/personal%3Auser%201',
    );
    expect(
      (calls[0]!.init.headers as Record<string, string>).authorization,
    ).toBe('Bearer sk_test_x');
  });

  it('answers null for a missing org', async () => {
    const { client } = recorder([[404, { code: 'entity_not_found' }]]);
    expect(await client.organizationByExternalId('x')).toBeNull();
  });

  it('creates an org with external_id', async () => {
    const { calls, client } = recorder([[201, { id: 'org_1', name: 'n' }]]);
    await client.createOrganization({ name: 'n', externalId: 'e' });
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      name: 'n',
      external_id: 'e',
    });
  });

  it('lists memberships by user and org', async () => {
    const { calls, client } = recorder([[200, { data: [] }]]);
    await client.memberships({ userId: 'user_1', organizationId: 'org_1' });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/user_management/organization_memberships');
    expect(url.searchParams.get('user_id')).toBe('user_1');
    expect(url.searchParams.get('organization_id')).toBe('org_1');
  });

  it('creates a membership with role_slug', async () => {
    const { calls, client } = recorder([[201, { id: 'om_1' }]]);
    await client.createMembership({
      userId: 'u',
      organizationId: 'o',
      roleSlug: 'admin',
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      user_id: 'u',
      organization_id: 'o',
      role_slug: 'admin',
    });
  });

  it('turns an error into WorkosError without the key', async () => {
    const { client } = recorder([
      [422, { code: 'invalid', message: 'bad name' }],
    ]);
    const e = await client
      .createOrganization({ name: '', externalId: 'e' })
      .catch((e) => e);
    expect(e).toBeInstanceOf(WorkosError);
    expect(e).toMatchObject({ status: 422, code: 'invalid' });
    expect(String(e.message)).toContain('bad name');
    expect(String(e.message)).not.toContain('sk_test');
  });

  it('selects an org with the secret in the form, not a bearer', async () => {
    const { calls, client } = recorder([
      [200, { access_token: 'a', refresh_token: 'r', user: {} }],
    ]);
    await client.selectOrganization({
      clientId: 'client_1',
      pendingAuthenticationToken: 'p',
      organizationId: 'org_1',
    });
    const init = calls[0]!.init;
    const headers = init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe(
      'https://api.workos.test/user_management/authenticate',
    );
    expect(headers.authorization).toBeUndefined();
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: 'urn:workos:oauth:grant-type:organization-selection',
      client_id: 'client_1',
      client_secret: 'sk_test_x',
      pending_authentication_token: 'p',
      organization_id: 'org_1',
    });
  });

  it('reads an OAuth-style error', async () => {
    const { client } = recorder([
      [
        400,
        {
          error: 'invalid_client',
          error_description: 'Invalid client secret.',
        },
      ],
    ]);
    const e = await client
      .selectOrganization({
        clientId: 'c',
        pendingAuthenticationToken: 'p',
        organizationId: 'o',
      })
      .catch((e) => e);
    expect(e).toMatchObject({ status: 400, code: 'invalid_client' });
    expect(String(e.message)).not.toContain('sk_test');
  });

  it('copes with a non-JSON error', async () => {
    const { client } = recorder([[502, '<html>bad gateway</html>']]);
    const e = await client.user('u').catch((e) => e);
    expect(e).toMatchObject({ status: 502, code: undefined });
  });
});
