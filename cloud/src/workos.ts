/**
 * The slice of the WorkOS API the cloud uses, with the environment's API key.
 * The key lives only here (a Worker secret), never in the app.
 */
import { CloudError } from './errors';

export interface Organization {
  id: string;
  name: string;
  external_id?: string | null;
}

export interface User {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
}

export interface Membership {
  id: string;
  user_id: string;
  organization_id: string;
  status: string; // "active" | "inactive" | "pending"
  role?: { slug: string };
  organization_name?: string;
}

/** WorkOS's answer to a successful `authenticate`: a new session. */
export interface Authentication {
  user: User;
  organization_id?: string | null;
  access_token: string;
  refresh_token: string;
  authentication_method?: string;
}

export interface Workos {
  organizationByExternalId(externalId: string): Promise<Organization | null>;
  createOrganization(o: {
    name: string;
    externalId: string;
  }): Promise<Organization>;
  user(userId: string): Promise<User>;
  memberships(o: {
    userId: string;
    organizationId?: string;
  }): Promise<Membership[]>;
  organization(id: string): Promise<Organization>;
  createMembership(o: {
    userId: string;
    organizationId: string;
    roleSlug: string;
  }): Promise<Membership>;
  /**
   * Finishes a sign-in that ended in `organization_selection_required`. Needs
   * the client secret (a public client gets `invalid_client`, checked live
   * against staging), so the app can't do it itself.
   */
  selectOrganization(o: {
    clientId: string;
    pendingAuthenticationToken: string;
    organizationId: string;
  }): Promise<Authentication>;
  /**
   * AuthKit's code, after the browser came back to the cloud's own
   * callback (MCP sign-in): the cloud is the confidential client here. A
   * user in 2+ orgs gets `403 organization_selection_required`
   * (`WorkosError.body` carries the pending token and the orgs).
   */
  authenticateWithCode(o: {
    clientId: string;
    code: string;
  }): Promise<Authentication>;
  /** A refresh, optionally into `organizationId` (MCP token refresh). */
  refreshSession(o: {
    clientId: string;
    refreshToken: string;
    organizationId?: string;
  }): Promise<Authentication>;
  /** Deletes an organization; one already gone (404) is fine. */
  deleteOrganization(id: string): Promise<void>;
  /** Deletes a user (and their memberships, sessions); 404 is fine. */
  deleteUser(userId: string): Promise<void>;
}

/** A WorkOS answer other than 2xx. `status` decides what the caller does. */
export class WorkosError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    /** The answer's JSON, when it had one (never logged: it may hold a token). */
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WorkosError';
  }
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class WorkosClient implements Workos {
  // Called through a closure: a bare `fetch` stored on an object and called
  // as a method throws "Illegal invocation" in Workers.
  constructor(
    private readonly apiKey: string,
    private readonly apiBase: string,
    private readonly fetchFn: Fetch = (input, init) => fetch(input, init),
  ) {}

  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    form?: Record<string, string>,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    let payload: string | undefined;
    if (form) {
      // `authenticate` takes the secret in the form, not as a bearer.
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    } else {
      headers.authorization = `Bearer ${this.apiKey}`;
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }
    const res = await this.fetchFn(
      `${this.apiBase.replace(/\/+$/, '')}${path}`,
      { method, headers, body: payload },
    );
    const text = await res.text();
    if (!res.ok) {
      let code: string | undefined;
      let message = `WorkOS ${method} ${path.split('?')[0]} failed (${res.status})`;
      let body: Record<string, unknown> | undefined;
      try {
        const e = JSON.parse(text) as Record<string, unknown>;
        body = e;
        // `authenticate` answers OAuth-style (`error`, `error_description`),
        // the rest of the API with `code`, `message`.
        const c = e.code ?? e.error;
        const m = e.message ?? e.error_description;
        code = typeof c === 'string' ? c : undefined;
        if (typeof m === 'string') message = `${message}: ${m}`;
      } catch {
        // not JSON: keep the status line only
      }
      throw new WorkosError(res.status, code, message, body);
    }
    // A DELETE answers 202 or 204 with no body.
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }

  /** A DELETE that already happened (404) counts as done. */
  private async remove(path: string): Promise<void> {
    try {
      await this.call<unknown>('DELETE', path);
    } catch (e) {
      if (e instanceof WorkosError && e.status === 404) return;
      throw e;
    }
  }

  async organizationByExternalId(
    externalId: string,
  ): Promise<Organization | null> {
    try {
      return await this.call<Organization>(
        'GET',
        `/organizations/external_id/${encodeURIComponent(externalId)}`,
      );
    } catch (e) {
      if (e instanceof WorkosError && e.status === 404) return null;
      throw e;
    }
  }

  createOrganization(o: {
    name: string;
    externalId: string;
  }): Promise<Organization> {
    return this.call('POST', '/organizations', {
      name: o.name,
      external_id: o.externalId,
    });
  }

  user(userId: string): Promise<User> {
    return this.call(
      'GET',
      `/user_management/users/${encodeURIComponent(userId)}`,
    );
  }

  async memberships(o: {
    userId: string;
    organizationId?: string;
  }): Promise<Membership[]> {
    const q = new URLSearchParams({ user_id: o.userId, limit: '100' });
    if (o.organizationId) q.set('organization_id', o.organizationId);
    const page = await this.call<{ data: Membership[] }>(
      'GET',
      `/user_management/organization_memberships?${q}`,
    );
    return page.data;
  }

  organization(id: string): Promise<Organization> {
    return this.call('GET', `/organizations/${encodeURIComponent(id)}`);
  }

  deleteOrganization(id: string): Promise<void> {
    return this.remove(`/organizations/${encodeURIComponent(id)}`);
  }

  deleteUser(userId: string): Promise<void> {
    return this.remove(`/user_management/users/${encodeURIComponent(userId)}`);
  }

  createMembership(o: {
    userId: string;
    organizationId: string;
    roleSlug: string;
  }): Promise<Membership> {
    return this.call('POST', '/user_management/organization_memberships', {
      user_id: o.userId,
      organization_id: o.organizationId,
      role_slug: o.roleSlug,
    });
  }

  selectOrganization(o: {
    clientId: string;
    pendingAuthenticationToken: string;
    organizationId: string;
  }): Promise<Authentication> {
    return this.call('POST', '/user_management/authenticate', undefined, {
      grant_type: 'urn:workos:oauth:grant-type:organization-selection',
      client_id: o.clientId,
      client_secret: this.apiKey,
      pending_authentication_token: o.pendingAuthenticationToken,
      organization_id: o.organizationId,
    });
  }

  authenticateWithCode(o: {
    clientId: string;
    code: string;
  }): Promise<Authentication> {
    return this.call('POST', '/user_management/authenticate', undefined, {
      grant_type: 'authorization_code',
      client_id: o.clientId,
      client_secret: this.apiKey,
      code: o.code,
    });
  }

  refreshSession(o: {
    clientId: string;
    refreshToken: string;
    organizationId?: string;
  }): Promise<Authentication> {
    return this.call('POST', '/user_management/authenticate', undefined, {
      grant_type: 'refresh_token',
      client_id: o.clientId,
      client_secret: this.apiKey,
      refresh_token: o.refreshToken,
      ...(o.organizationId ? { organization_id: o.organizationId } : {}),
    });
  }
}

/** AuthKit's hosted sign-in, back to `redirectUri` with a code. */
export function authkitAuthorizeUrl(
  apiBase: string,
  o: { clientId: string; redirectUri: string; state: string },
): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    provider: 'authkit',
    state: o.state,
  });
  return `${apiBase.replace(/\/+$/, '')}/user_management/authorize?${q}`;
}

/** A WorkOS failure as the cloud's own answer. */
export function upstream(e: WorkosError): CloudError {
  // A 4xx with WorkOS's own code is an answer about the request (a used
  // pending token, an org the user isn't in); anything else is an outage.
  if (e.status >= 400 && e.status < 500 && e.code) {
    return new CloudError(400, 'cloud.rejected', `${e.code}: ${e.message}`);
  }
  return new CloudError(502, 'cloud.workos', e.message);
}
