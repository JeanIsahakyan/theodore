# Cloud

The server side of the Theodore account: a Cloudflare Worker in `cloud/`
(TypeScript, pnpm). One Worker per channel, each in front of its own WorkOS
environment.

Why it exists:

- The app is a **public client**: it can't hold the WorkOS API key or client
  secret. Anything that needs them runs here.
- The fleet will key its state by `org_id`. Every user gets an organization
  (alone, a personal one), so solo and team use run the same path.

## Routes

| Route | Auth | Does |
| --- | --- | --- |
| `GET /v1/health` | none | `{ "ok": true }` |
| `GET /v1/orgs` | bearer access JWT | the caller's active organizations, personal first: `{ organizations: [{ id, name, role, personal }] }` |
| `POST /v1/orgs/personal` | bearer access JWT | the caller's personal org, created once: `{ organization_id, created }` |
| `POST /v1/auth/select-organization` | none (the pending token is the credential) | finishes a sign-in that needs an org picked: `{ user, organization_id, access_token, refresh_token }` |

Body: JSON object, 64 KiB max. Errors: `{ "error": { "code", "message" } }`.

## Auth

```
Authorization: Bearer <access JWT>
  ─▶ JWKS  <api>/sso/jwks/<client_id>  ─▶ RS256 signature
  ─▶ iss = <api> or <api>/user_management/client_…
  ─▶ exp (60 s leeway) ─▶ client_id, if present, is ours or the issuer's
  ─▶ sub = caller   (org_id, role, permissions read when present)
```

Same checks as the app (`crates/account-workos/src/jwt.rs`), but strict: an
unreachable JWKS fails the request (`503`) instead of being skipped.

## Org flows

```
first sign-in
  app ─▶ session (no org) ─▶ POST /v1/orgs/personal
      ─▶ org external_id personal:<user_id>, membership role admin
      ─▶ app: refresh_token grant + organization_id ─▶ token with org_id, role

user in 2+ orgs (second sign-in)
  app ─▶ WorkOS 403 organization_selection_required
         { pending_authentication_token, organizations }
      ─▶ user picks ─▶ POST /v1/auth/select-organization
      ─▶ cloud: organization-selection grant + client secret ─▶ session ─▶ app

switch org
  app ─▶ refresh_token grant + organization_id (public client, no cloud)
```

`/v1/orgs/personal` is idempotent and race-safe: two concurrent calls end
with one org and one membership. A deactivated membership is not undone
(`409 cloud.membership_inactive`).

## App side

The app (`crates/account-workos`, `usecases/account.rs`) calls the cloud
only with a cloud URL configured (plan §6.12 "Organizations"):
`THEODORE_CLOUD_URL` env, the `account.cloud_url` setting, or the one
compiled in per channel (`build.yml` input `cloud-url`). No URL: sign-in
works as before, no organizations.

| App call | Goes to |
| --- | --- |
| sign-in (code, device), refresh, switch org (`refresh` + `organization_id`) | WorkOS directly |
| ensure the personal org (after sign-in, at start, while the session has no org) | cloud `POST /v1/orgs/personal` |
| list orgs (`account_organizations`) | cloud `GET /v1/orgs` |
| finish a sign-in that needs an org picked | cloud `POST /v1/auth/select-organization`, then the app validates the session itself |

| Cloud answer | App error |
| --- | --- |
| no connection, 5xx, 429, a 4xx without `{ error: { code } }` | `account.network` |
| `400 cloud.rejected` | `account.rejected` |
| any other 4xx | `account.protocol` (`code: message`) |

**The never-sign-out rule.** No cloud error and no org-scoped refresh ever
signs the user out or clears the session: the org step warns and retries at
the next start; a failed switch returns its error with the session
untouched. Only the background refresher, which never asks for an org,
ends a session. The access token and the pending token never land in an
error or a log.

## Verified against staging WorkOS

| Fact | Result |
| --- | --- |
| `refresh_token` grant with `organization_id`, public client, no secret | works: the app switches org itself |
| organization-selection grant without `client_secret` | `400 invalid_client "Invalid client secret."`: goes through the cloud |
| second sign-in of a user in 2+ orgs | `403 organization_selection_required` with `pending_authentication_token` and `organizations` |
| the pending token | single use |
| org-scoped access token | carries `org_id`, `role`, `permissions` |
| refresh into an org the user isn't in | `400 organization_membership_not_found`; the same refresh token still works afterwards (not burned), so a failed switch keeps the session |
| a plain refresh after an org-scoped one | keeps the org |
| membership objects | carry `organization_name` (the list needs no extra call per org) |

## Error codes

Stable `area.kind` codes, same form as the app's `error.code`
(`docs/telemetry.md`).

| Code | HTTP | When |
| --- | --- | --- |
| `cloud.unauthorized` | 401 | no or malformed bearer, bad signature, expired, wrong issuer or client, no subject |
| `cloud.jwks_unavailable` | 503 | the WorkOS signing keys couldn't be fetched |
| `cloud.rejected` | 400 | WorkOS refused with its own 4xx code (used pending token, org the user isn't in); the message carries it |
| `cloud.workos` | 502 | WorkOS failed otherwise (5xx, no code) |
| `cloud.bad_request` | 400 | body isn't a JSON object, or a required field is missing or too long |
| `cloud.too_large` | 413 | body over 64 KiB |
| `cloud.not_found` | 404 | no such route |
| `cloud.method` | 405 | method not allowed on that route |
| `cloud.membership_inactive` | 409 | the caller's personal-org membership is inactive or pending |
| `cloud.config` | 500 | `WORKOS_API_KEY` or `WORKOS_CLIENT_ID` missing |
| `cloud.internal` | 500 | anything unexpected; the log names the error kind, never the request |

## Environments and secrets

| | Staging | Production |
| --- | --- | --- |
| Worker | `theodore-cloud-staging` | `theodore-cloud` |
| WorkOS client id (`wrangler.toml` var) | `client_01M5RM1W36AHHEGBE37QD3PS6K` | `client_01M5RMBK860S2JJZNWJDDSH0BM` |
| WorkOS API key | Worker secret `WORKOS_API_KEY` | Worker secret `WORKOS_API_KEY` |
| Deployed by | push to `staging` | push to `main` |

- The API key is set by the owner, never in git or CI:
  `wrangler secret put WORKOS_API_KEY --env staging|production`. A deploy
  keeps it.
- Client ids are public: plain vars in `cloud/wrangler.toml`.
- The key is also the client secret for the organization-selection grant.

## Local dev

```
cd cloud
pnpm install
echo 'WORKOS_API_KEY=sk_test_…' > .dev.vars    # gitignored; staging key
pnpm dev                                        # wrangler dev --env staging
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

Tests run against a fake WorkOS: no network, no secrets. `ci.yml` (`cloud`
job) and the `lefthook` pre-push run the same checks.

## Deploy

```
push staging ─ cloud/** ─▶ cloud.yml: checks ─▶ deploy:staging    ─▶ theodore-cloud-staging
push main    ─ cloud/** ─▶ cloud.yml: checks ─▶ deploy:production ─▶ theodore-cloud
```

`workflow_dispatch` deploys a chosen environment by hand; production only
from `main`. Deploys per environment queue, never cancel. A push that
doesn't touch `cloud/` deploys nothing. No version bump or release is
involved (`docs/releasing.md`).

## One-time setup (owner)

Needed before the first deploy works; none of it is done yet.

1. `pnpm -C cloud exec wrangler login`
2. `wrangler secret put WORKOS_API_KEY --env staging`, then `--env production`
   (run in `cloud/`).
3. GitHub → Settings → Secrets and variables → Actions → **Secrets**:
   `CLOUDFLARE_API_TOKEN` (Workers edit permission) and
   `CLOUDFLARE_ACCOUNT_ID`.
4. Later: a custom domain per Worker (`routes` in `wrangler.toml`). Until
   then the Workers answer on `workers.dev`.

## Next

The fleet: one Durable Object per `org_id`, in this Worker.
