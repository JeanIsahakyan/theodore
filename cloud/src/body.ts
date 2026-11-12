import { CloudError } from './errors';

/**
 * Reads a JSON object body, at most `max` bytes, counting as it reads: a
 * chunked body declares no length, so `content-length` alone can't cap it.
 */
export async function readJson(
  request: Request,
  max: number,
): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new CloudError(413, 'cloud.too_large', 'request body too large');
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CloudError(400, 'cloud.bad_request', 'body is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CloudError(400, 'cloud.bad_request', 'body is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** A required, non-empty string field of bounded length. */
export function field(
  body: Record<string, unknown>,
  name: string,
  maxLength = 512,
): string {
  const v = body[name];
  if (typeof v !== 'string' || v === '' || v.length > maxLength) {
    throw new CloudError(400, 'cloud.bad_request', `${name} is required`);
  }
  return v;
}
