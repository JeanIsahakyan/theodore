/**
 * WorkOS AuthKit as a public client, plus the cloud's org endpoints. The
 * same endpoints, parameters and error mapping as
 * `crates/account-workos/src/lib.rs`; `fetch` is injected so this is pure.
 *
 * ```text
 * code     POST /user_management/authenticate  authorization_code + code_verifier + client_id
 * refresh  POST /user_management/authenticate  refresh_token (+ organization_id)
 *            4xx organization_selection_required ─▶ { pending token, organizations }
 * cloud    POST /v1/auth/select-organization   (pending token) ─▶ session
 *          POST /v1/orgs/personal  GET /v1/orgs (Bearer access token)
 * validate GET  /sso/jwks/<client_id> ─▶ RS256, iss, exp, client_id, sub
 *            JWKS unreachable: a token straight from WorkOS keeps its claim
 *            checks; one the cloud handed over fails (`network`)
 * logout   GET  /user_management/sessions/logout?session_id=<sid>
 * ```
 */
import type { Organization, OrganizationChoice, Session } from './types';
import { AuthError } from './errors';
import {
  checkClaims,
  findKey,
  parseJwt,
  verifySignature,
  type Claims,
  type Jwk,
  type Jwks,
} from './jwt';
import { trimSlash } from './pkce';

export interface HttpResponse {
  status: number;
  text(): Promise<string>;
}

export type HttpFetch = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    redirect?: 'manual';
  },
) => Promise<HttpResponse>;

export interface WorkosConfig {
  apiBase: string;
  clientId: string;
  /** The Theodore cloud; null: sign-in works, organizations don't. */
  cloudUrl: string | null;
  /** More accepted `iss` values (a custom authentication domain). */
  extraIssuers?: string[];
}

export interface OrganizationSelection {
  pendingToken: string;
  organizations: OrganizationChoice[];
}

export type Authenticated =
  | { kind: 'session'; session: Session }
  | { kind: 'select'; selection: OrganizationSelection };

/** What `AuthKitClient` needs from the network (a fake in tests). */
export interface AccountApi {
  exchangeCode(code: string, verifier: string): Promise<Authenticated>;
  refresh(
    refreshToken: string,
    organizationId: string | null,
  ): Promise<Authenticated>;
  selectOrganization(
    pendingToken: string,
    organizationId: string,
  ): Promise<Session>;
  ensurePersonalOrganization(accessToken: string): Promise<string>;
  organizations(accessToken: string): Promise<Organization[]>;
  logout(sessionId: string): Promise<void>;
}

const ORG_SELECTION_REQUIRED = 'organization_selection_required';
const CLOUD_REJECTED = 'cloud.rejected';

type Source =
  { kind: 'provider' } | { kind: 'cloud_selected'; organizationId: string };

type Reply =
  | { ok: true; body: string }
  | {
      ok: false;
      code: string;
      message: string;
      pendingToken: string | null;
      organizations: OrganizationChoice[];
    };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function orgChoices(v: unknown): OrganizationChoice[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isObj)
    .filter((o) => typeof o.id === 'string' && o.id !== '')
    .map((o) => ({ id: o.id as string, name: str(o.name) ?? '' }));
}

/** A successful authenticate body, before the token checks. */
export interface AuthResponse {
  userId: string;
  email: string;
  name: string | null;
  organizationId: string | null;
  accessToken: string;
  refreshToken: string;
}

export function parseAuthResponse(body: string): AuthResponse {
  const v = parseJson(body);
  const bad = (what: string) =>
    new AuthError('protocol', `decode authenticate response: ${what}`);
  if (!isObj(v)) throw bad('not an object');
  const user = v.user;
  if (!isObj(user)) throw bad('no user');
  const userId = str(user.id);
  if (!userId) throw bad('no user id');
  if (typeof user.email !== 'string') throw bad('no email');
  const accessToken = str(v.access_token);
  const refreshToken = str(v.refresh_token);
  if (!accessToken || !refreshToken) throw bad('no tokens');
  const name =
    [str(user.first_name), str(user.last_name)].filter(Boolean).join(' ') ||
    null;
  return {
    userId,
    email: user.email,
    name,
    organizationId: str(v.organization_id),
    accessToken,
    refreshToken,
  };
}

/** The provider's error body, mapped like `post_form`. */
export function parseProviderError(status: number, text: string): Reply {
  const v = parseJson(text);
  const body = isObj(v) ? v : {};
  const code = str(body.error) ?? str(body.code);
  if (!code) {
    // A 4xx without the provider's JSON came from something in between (a
    // captive portal, a proxy): a connection problem, the session survives.
    throw new AuthError(
      'network',
      `authenticate failed (${status}) without a provider error`,
    );
  }
  const described = str(body.error_description) ?? str(body.message);
  const message =
    described ??
    // The raw body of an org-selection answer holds the pending token.
    (code === ORG_SELECTION_REQUIRED ? '' : text.slice(0, 200));
  return {
    ok: false,
    code,
    message,
    pendingToken: str(body.pending_authentication_token),
    organizations: orgChoices(body.organizations),
  };
}

/** The cloud's `{ error: { code, message } }`, mapped like `cloud()`. */
export function cloudError(
  status: number,
  path: string,
  text: string,
): AuthError {
  const v = parseJson(text);
  const err = isObj(v) && isObj(v.error) ? v.error : null;
  const code = err ? str(err.code) : null;
  if (!code) {
    return new AuthError(
      'network',
      `cloud ${path} failed (${status}) without a cloud error`,
    );
  }
  const message = (typeof err?.message === 'string' ? err.message : '').slice(
    0,
    200,
  );
  return status === 400 && code === CLOUD_REJECTED
    ? new AuthError('rejected', `${code}: ${message}`)
    : new AuthError('protocol', `${code}: ${message}`);
}

const transport = (what: string, e: unknown) =>
  new AuthError(
    'network',
    `${what}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
  );

export class WorkosApi implements AccountApi {
  private readonly api: string;
  private readonly issuers: string[];
  private jwks: Jwks | null = null;

  constructor(
    private readonly cfg: WorkosConfig,
    private readonly fetch: HttpFetch,
    private readonly nowMs: () => number = Date.now,
    private readonly warn: (m: string) => void = () => {},
  ) {
    this.api = trimSlash(cfg.apiBase);
    this.issuers = [this.api, ...(cfg.extraIssuers ?? [])];
  }

  private async postForm(
    path: string,
    form: Record<string, string>,
  ): Promise<Reply> {
    let res: HttpResponse;
    let text: string;
    try {
      res = await this.fetch(`${this.api}/${path}`, {
        method: 'POST',
        // JSON, not a form: WorkOS sends CORS headers only on JSON
        // requests, and the web app can't read a form post's answer.
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(form),
      });
      text = await res.text();
    } catch (e) {
      throw transport(path, e);
    }
    if (res.status >= 500 || res.status === 429) {
      throw new AuthError('network', `${path} failed (${res.status})`);
    }
    if (res.status >= 200 && res.status < 300) return { ok: true, body: text };
    return parseProviderError(res.status, text);
  }

  private async cloud(
    method: 'GET' | 'POST',
    path: string,
    bearer: string | null,
    body: unknown,
  ): Promise<string> {
    const base = this.cfg.cloudUrl ? trimSlash(this.cfg.cloudUrl) : '';
    if (!base) throw new AuthError('config', 'no Theodore cloud configured');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: HttpResponse;
    let text: string;
    try {
      res = await this.fetch(`${base}/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      text = await res.text();
    } catch (e) {
      throw transport(`cloud ${path}`, e);
    }
    if (res.status >= 500 || res.status === 429) {
      throw new AuthError('network', `cloud ${path} failed (${res.status})`);
    }
    if (res.status >= 200 && res.status < 300) return text;
    throw cloudError(res.status, path, text);
  }

  private async authenticate(
    form: Record<string, string>,
  ): Promise<Authenticated> {
    const reply = await this.postForm('user_management/authenticate', form);
    if (reply.ok) {
      return {
        kind: 'session',
        session: await this.sessionFrom(reply.body, { kind: 'provider' }),
      };
    }
    if (reply.code === ORG_SELECTION_REQUIRED) {
      if (!reply.pendingToken || reply.organizations.length === 0) {
        throw new AuthError(
          'protocol',
          'organization selection required without a pending token or organizations',
        );
      }
      return {
        kind: 'select',
        selection: {
          pendingToken: reply.pendingToken,
          organizations: reply.organizations,
        },
      };
    }
    throw new AuthError('rejected', `${reply.code}: ${reply.message}`);
  }

  /** Builds a session from an authenticate-shaped body, validated. */
  async sessionFrom(body: string, source: Source): Promise<Session> {
    const r = parseAuthResponse(body);
    const claims = await this.checkToken(r.accessToken, r.userId, source);
    if (source.kind === 'cloud_selected') {
      const sessionOrg = r.organizationId ?? claims.org_id ?? null;
      if (
        sessionOrg !== source.organizationId ||
        claims.org_id !== source.organizationId
      ) {
        throw new AuthError(
          'invalid_token',
          "the session isn't in the organization chosen",
        );
      }
    }
    return {
      userId: r.userId,
      email: r.email,
      name: r.name,
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
      expiresAt: claims.exp * 1000,
      organizationId: r.organizationId ?? claims.org_id ?? null,
      role: claims.role || null,
    };
  }

  private async checkToken(
    token: string,
    userId: string,
    source: Source,
  ): Promise<Claims> {
    const parsed = parseJwt(token);
    let key: Jwk | null = null;
    try {
      key = await this.keyFor(parsed.kid);
    } catch (e) {
      if (!(e instanceof AuthError) || e.kind !== 'network') throw e;
      if (source.kind === 'cloud_selected') {
        // A token the cloud handed over is only as good as its signature.
        throw new AuthError(
          'network',
          `can't check the session's signature: ${e.message}`,
        );
      }
      // Straight from WorkOS over TLS: the signature is defense in depth.
      this.warn(
        `JWKS unreachable, access token signature not checked: ${e.message}`,
      );
    }
    if (key) verifySignature(parsed, key);
    checkClaims(
      parsed.claims,
      this.issuers,
      this.cfg.clientId,
      userId,
      Math.floor(this.nowMs() / 1000),
    );
    return parsed.claims;
  }

  private async keyFor(kid: string | null): Promise<Jwk> {
    const cached = this.jwks && findKey(this.jwks, kid);
    if (cached) return cached;
    const path = `sso/jwks/${encodeURIComponent(this.cfg.clientId)}`;
    let res: HttpResponse;
    let text: string;
    try {
      res = await this.fetch(`${this.api}/${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      text = await res.text();
    } catch (e) {
      throw transport('JWKS', e);
    }
    if (res.status >= 500) {
      throw new AuthError('network', `JWKS fetch failed (${res.status})`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new AuthError('invalid_token', `JWKS fetch failed (${res.status})`);
    }
    const v = parseJson(text);
    if (!isObj(v) || !Array.isArray(v.keys)) {
      throw new AuthError('protocol', 'decode JWKS');
    }
    const jwks: Jwks = {
      keys: v.keys.filter(isObj).map((k) => ({
        kid: typeof k.kid === 'string' ? k.kid : undefined,
        kty: typeof k.kty === 'string' ? k.kty : '',
        n: typeof k.n === 'string' ? k.n : undefined,
        e: typeof k.e === 'string' ? k.e : undefined,
      })),
    };
    this.jwks = jwks;
    const key = findKey(jwks, kid);
    if (!key)
      throw new AuthError('invalid_token', 'token signed with an unknown key');
    return key;
  }

  exchangeCode(code: string, verifier: string): Promise<Authenticated> {
    return this.authenticate({
      grant_type: 'authorization_code',
      client_id: this.cfg.clientId,
      code,
      code_verifier: verifier,
    });
  }

  refresh(
    refreshToken: string,
    organizationId: string | null,
  ): Promise<Authenticated> {
    const form: Record<string, string> = {
      grant_type: 'refresh_token',
      client_id: this.cfg.clientId,
      refresh_token: refreshToken,
    };
    if (organizationId) form.organization_id = organizationId;
    return this.authenticate(form);
  }

  async selectOrganization(
    pendingToken: string,
    organizationId: string,
  ): Promise<Session> {
    const body = await this.cloud('POST', 'v1/auth/select-organization', null, {
      pending_authentication_token: pendingToken,
      organization_id: organizationId,
    });
    // The cloud's session isn't taken as is: its refresh token is traded
    // straight with WorkOS (over TLS, CORS-allowed on the web), so the
    // session kept comes from WorkOS itself. A forged token fails there.
    // Needed on the web, where WorkOS's JWKS has no CORS and the cloud's
    // access token couldn't be signature-checked.
    const handed = parseAuthResponse(body);
    const direct = await this.refresh(handed.refreshToken, organizationId);
    if (direct.kind !== 'session') {
      throw new AuthError(
        'protocol',
        'WorkOS asked for another organization choice',
      );
    }
    const session = direct.session;
    if (
      session.userId !== handed.userId ||
      session.organizationId !== organizationId
    ) {
      throw new AuthError(
        'invalid_token',
        "the session isn't in the organization chosen",
      );
    }
    return session;
  }

  async ensurePersonalOrganization(accessToken: string): Promise<string> {
    const body = await this.cloud('POST', 'v1/orgs/personal', accessToken, {});
    const v = parseJson(body);
    const id = isObj(v) ? str(v.organization_id) : null;
    if (!id) {
      throw new AuthError('protocol', 'the cloud returned no organization id');
    }
    return id;
  }

  async organizations(accessToken: string): Promise<Organization[]> {
    const body = await this.cloud('GET', 'v1/orgs', accessToken, undefined);
    const v = parseJson(body);
    if (!isObj(v) || !Array.isArray(v.organizations)) {
      throw new AuthError('protocol', 'decode organizations');
    }
    return v.organizations
      .filter(isObj)
      .filter((o) => str(o.id))
      .map((o) => ({
        id: o.id as string,
        name: typeof o.name === 'string' ? o.name : '',
        role: str(o.role),
        personal: o.personal === true,
      }));
  }

  async logout(sessionId: string): Promise<void> {
    let res: HttpResponse;
    try {
      res = await this.fetch(
        `${this.api}/user_management/sessions/logout?session_id=${encodeURIComponent(sessionId)}`,
        { method: 'GET', headers: {}, redirect: 'manual' },
      );
    } catch (e) {
      throw transport('logout', e);
    }
    // 0: the browser's opaque answer to a redirect it didn't follow.
    if (res.status === 0 || (res.status >= 200 && res.status < 400)) return;
    if (res.status >= 500) {
      throw new AuthError('network', `logout failed (${res.status})`);
    }
    throw new AuthError('rejected', `logout failed (${res.status})`);
  }
}
