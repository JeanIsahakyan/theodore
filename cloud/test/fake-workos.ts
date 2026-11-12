// An in-memory WorkOS with scriptable failures.
import {
  WorkosError,
  type Authentication,
  type Membership,
  type Organization,
  type Workos,
} from '../src/workos';

export class FakeWorkos implements Workos {
  orgs: Organization[] = [];
  memberships_: Membership[] = [];
  calls: string[] = [];
  /** Runs before a create: lets a test slip a concurrent create in. */
  beforeCreateOrg?: () => void;
  beforeCreateMembership?: () => void;
  failWith?: WorkosError;

  private seq = 0;
  private id = (p: string) => `${p}_${++this.seq}`;
  private check() {
    if (this.failWith) throw this.failWith;
  }

  async organizationByExternalId(externalId: string) {
    this.calls.push(`getOrg ${externalId}`);
    this.check();
    return this.orgs.find((o) => o.external_id === externalId) ?? null;
  }

  async createOrganization(o: { name: string; externalId: string }) {
    this.calls.push(`createOrg ${o.name}`);
    this.check();
    this.beforeCreateOrg?.();
    if (this.orgs.some((x) => x.external_id === o.externalId)) {
      throw new WorkosError(422, 'external_id_taken', 'taken');
    }
    const org = { id: this.id('org'), name: o.name, external_id: o.externalId };
    this.orgs.push(org);
    return org;
  }

  async user(userId: string) {
    this.calls.push(`getUser ${userId}`);
    this.check();
    return { id: userId, email: `${userId}@example.test` };
  }

  async memberships(o: { userId: string; organizationId?: string }) {
    this.calls.push('listMemberships');
    this.check();
    return this.memberships_.filter(
      (m) =>
        m.user_id === o.userId &&
        (o.organizationId === undefined ||
          m.organization_id === o.organizationId),
    );
  }

  async organization(id: string) {
    this.calls.push(`getOrgById ${id}`);
    this.check();
    const org = this.orgs.find((o) => o.id === id);
    if (!org) throw new WorkosError(404, 'entity_not_found', 'no org');
    return org;
  }

  async createMembership(o: {
    userId: string;
    organizationId: string;
    roleSlug: string;
  }) {
    this.calls.push(`createMembership ${o.roleSlug}`);
    this.check();
    this.beforeCreateMembership?.();
    if (
      this.memberships_.some(
        (m) => m.user_id === o.userId && m.organization_id === o.organizationId,
      )
    ) {
      throw new WorkosError(422, 'already_member', 'exists');
    }
    return this.addMembership(o.userId, o.organizationId, o.roleSlug);
  }

  selections: Array<{ clientId: string; pending: string; org: string }> = [];
  async selectOrganization(o: {
    clientId: string;
    pendingAuthenticationToken: string;
    organizationId: string;
  }): Promise<Authentication> {
    this.calls.push('selectOrganization');
    this.check();
    this.selections.push({
      clientId: o.clientId,
      pending: o.pendingAuthenticationToken,
      org: o.organizationId,
    });
    if (o.pendingAuthenticationToken === 'used') {
      throw new WorkosError(400, 'invalid_grant', 'pending token used');
    }
    return {
      user: { id: 'user_1', email: 'u@example.test' },
      organization_id: o.organizationId,
      access_token: 'at',
      refresh_token: 'rt',
      authentication_method: 'Password',
    };
  }

  addMembership(
    userId: string,
    organizationId: string,
    role = 'admin',
    status = 'active',
  ) {
    const m: Membership = {
      id: this.id('om'),
      user_id: userId,
      organization_id: organizationId,
      status,
      role: { slug: role },
    };
    this.memberships_.push(m);
    return m;
  }
}
