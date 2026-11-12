/**
 * An error the cloud answers with: an HTTP status and a stable code in the
 * same `area.kind` form the app logs as `error.code` (docs/telemetry.md).
 * `message` is for people; it never carries a token or a secret.
 */
export class CloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

export function errorResponse(e: CloudError): Response {
  return json({ error: { code: e.code, message: e.message } }, e.status);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}
