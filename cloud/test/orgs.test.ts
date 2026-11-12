import { describe, expect, it } from 'vitest';
import { CloudError } from '../src/errors';
import { ensurePersonalOrganization, personalExternalId } from '../src/orgs';
import { WorkosError } from '../src/workos';
import { FakeWorkos } from './fake-workos';

describe('ensurePersonalOrganization', () => {
  it('creates the org and an admin membership the first time', async () => {
    const w = new FakeWorkos();
    const r = await ensurePersonalOrganization('user_1', w);
    expect(r.created).toBe(true);
    expect(w.orgs).toEqual([
      {
        id: r.organization_id,
        name: 'Personal (user_1@example.test)',
        external_id: 'personal:user_1',
      },
    ]);
    expect(w.memberships_.map((m) => [m.user_id, m.role?.slug])).toEqual([
      ['user_1', 'admin'],
    ]);
  });

  it('is idempotent', async () => {
    const w = new FakeWorkos();
    const a = await ensurePersonalOrganization('user_1', w);
    w.calls = [];
    const b = await ensurePersonalOrganization('user_1', w);
    expect(b).toEqual({ organization_id: a.organization_id, created: false });
    expect(w.calls).toEqual(['getOrg personal:user_1', 'listMemberships']);
    expect(w.orgs).toHaveLength(1);
    expect(w.memberships_).toHaveLength(1);
  });

  it('keeps users apart', async () => {
    const w = new FakeWorkos();
    const a = await ensurePersonalOrganization('user_1', w);
    const b = await ensurePersonalOrganization('user_2', w);
    expect(a.organization_id).not.toBe(b.organization_id);
  });

  it('adopts an org another request created meanwhile', async () => {
    const w = new FakeWorkos();
    w.beforeCreateOrg = () => {
      w.beforeCreateOrg = undefined;
      w.orgs.push({
        id: 'org_race',
        name: 'x',
        external_id: personalExternalId('user_1'),
      });
    };
    const r = await ensurePersonalOrganization('user_1', w);
    expect(r).toEqual({ organization_id: 'org_race', created: false });
    expect(w.orgs).toHaveLength(1);
  });

  it('adopts a membership another request created meanwhile', async () => {
    const w = new FakeWorkos();
    w.beforeCreateMembership = () => {
      w.beforeCreateMembership = undefined;
      w.addMembership('user_1', w.orgs[0]!.id);
    };
    await ensurePersonalOrganization('user_1', w);
    expect(w.memberships_).toHaveLength(1);
  });

  it('does not undo a deactivated membership', async () => {
    const w = new FakeWorkos();
    const { organization_id } = await ensurePersonalOrganization('user_1', w);
    w.memberships_[0]!.status = 'inactive';
    const e = await ensurePersonalOrganization('user_1', w).catch((e) => e);
    expect(e).toBeInstanceOf(CloudError);
    expect((e as CloudError).code).toBe('cloud.membership_inactive');
    expect(w.memberships_[0]!.organization_id).toBe(organization_id);
  });

  it('passes a WorkOS outage through', async () => {
    const w = new FakeWorkos();
    w.failWith = new WorkosError(503, undefined, 'down');
    await expect(ensurePersonalOrganization('user_1', w)).rejects.toBe(
      w.failWith,
    );
  });
});
