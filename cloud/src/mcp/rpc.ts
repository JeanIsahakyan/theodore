/**
 * MCP over Streamable HTTP at `/mcp`, both eras (docs/fleet.md "MCP over
 * the cloud"):
 *
 * ```text
 * POST /mcp {jsonrpc, id, method, params}
 *   notification / response          ─▶ 202
 *   params._meta protocolVersion     ─▶ modern (2026-07-28): stateless; the
 *     MCP-Protocol-Version, Mcp-Method (and for tools/call Mcp-Name) headers
 *     must match the body (400 -32020); another version ─▶ 400 -32022
 *   initialize                       ─▶ legacy (2025-03-26 … 2025-11-25),
 *     no session id: every request stands alone
 *   server/discover · ping · tools/list · tools/call (─▶ the org's hub)
 *   anything else                    ─▶ -32601 (404 for a modern request)
 * GET / DELETE /mcp                  ─▶ 405 (no standalone stream, no sessions)
 * ```
 */
import { TOOLS, type ToolResult } from './tools';

export const MODERN_VERSION = '2026-07-28';
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];

/** A JSON-RPC body over this is refused (tool arguments are small). */
const MAX_RPC_BYTES = 256 * 1024;

export const SERVER_INFO = { name: 'theodore', version: '1.0.0' };

export const INSTRUCTIONS =
  'Theodore runs coding agents ("spaces") on the user’s own computers. Start with theodore_status. ' +
  'A computer takes requests from Claude only after the user trusts "Claude (MCP)" on it (Theodore → Devices, comparing the fingerprint from theodore_status), ' +
  'and Claude reaches only computers trusted with device_trust, using the fingerprint the user reads on that computer. ' +
  'Ask and Plan run directly; Edit and Run, and approving a plan, wait for a person’s yes on the computer (or on a phone or computer it sends its approvals to), unless the user turned on auto mode there (no or no answer: fleet.denied). ' +
  'Then: projects_list ─▶ space_start ─▶ space_wait ─▶ space_read ─▶ space_send / ask_answer / plan_approve.';

export interface RpcDeps {
  /** Runs a tool for the signed-in user (in the org's hub). */
  call(name: string, args: unknown): Promise<ToolResult>;
}

type Id = string | number;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });

const rpcError = (
  id: Id | null,
  code: number,
  message: string,
  status: number,
  data?: unknown,
) =>
  json(
    {
      jsonrpc: '2.0',
      id,
      error: data === undefined ? { code, message } : { code, message, data },
    },
    status,
  );

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;

/** `=?base64?…?=` decoded (UTF-8); a plain value as it is. */
export function headerValue(v: string | null): string | null {
  if (v === null) return null;
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try {
    const raw = atob(m[1]!);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}

async function readBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RPC_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function handleRpc(
  request: Request,
  deps: RpcDeps,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }
  const text = await readBody(request);
  if (text === null) {
    return rpcError(null, INVALID_REQUEST, 'request too large', 413);
  }
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return rpcError(null, PARSE_ERROR, 'parse error', 400);
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    // Batches went away in 2025-06-18; none is accepted.
    return rpcError(
      null,
      INVALID_REQUEST,
      'one JSON-RPC message per POST',
      400,
    );
  }
  const m = msg as Record<string, unknown>;
  const id = m.id;
  const hasId = typeof id === 'string' || typeof id === 'number';
  if (m.jsonrpc !== '2.0') {
    return rpcError(
      hasId ? id : null,
      INVALID_REQUEST,
      'not JSON-RPC 2.0',
      400,
    );
  }
  // A notification (or a response, from an older client): nothing to say.
  if (!hasId) {
    return typeof m.method === 'string' || 'result' in m || 'error' in m
      ? new Response(null, { status: 202 })
      : rpcError(null, INVALID_REQUEST, 'invalid message', 400);
  }
  if (typeof m.method !== 'string') {
    return rpcError(id, INVALID_REQUEST, 'method is required', 400);
  }
  const method = m.method;
  const params =
    m.params && typeof m.params === 'object' && !Array.isArray(m.params)
      ? (m.params as Record<string, unknown>)
      : {};
  const meta =
    params._meta && typeof params._meta === 'object'
      ? (params._meta as Record<string, unknown>)
      : {};
  const declared = meta['io.modelcontextprotocol/protocolVersion'];
  const header = request.headers.get('mcp-protocol-version');

  if (method === 'initialize') {
    const asked = params.protocolVersion;
    const version =
      typeof asked === 'string' && LEGACY_VERSIONS.includes(asked)
        ? asked
        : LEGACY_VERSIONS[0]!;
    return json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      },
    });
  }

  const modern = typeof declared === 'string';
  if (modern) {
    if (header !== declared) {
      return rpcError(
        id,
        HEADER_MISMATCH,
        'Header mismatch: MCP-Protocol-Version must match the request’s protocol version',
        400,
      );
    }
    if (declared !== MODERN_VERSION) {
      return rpcError(
        id,
        UNSUPPORTED_VERSION,
        'Unsupported protocol version',
        400,
        { supported: SUPPORTED_VERSIONS, requested: declared },
      );
    }
    if (request.headers.get('mcp-method') !== method) {
      return rpcError(
        id,
        HEADER_MISMATCH,
        'Header mismatch: Mcp-Method must match the method',
        400,
      );
    }
    if (
      method === 'tools/call' &&
      headerValue(request.headers.get('mcp-name')) !== params.name
    ) {
      return rpcError(
        id,
        HEADER_MISMATCH,
        'Header mismatch: Mcp-Name must match the tool name',
        400,
      );
    }
  } else if (header !== null && !LEGACY_VERSIONS.includes(header)) {
    // A modern version named without `_meta`, or one this server lacks.
    return header === MODERN_VERSION
      ? rpcError(
          id,
          HEADER_MISMATCH,
          'Header mismatch: the request has no protocol version in _meta',
          400,
        )
      : rpcError(id, UNSUPPORTED_VERSION, 'Unsupported protocol version', 400, {
          supported: SUPPORTED_VERSIONS,
          requested: header,
        });
  }

  const done = (result: Record<string, unknown>) =>
    json({
      jsonrpc: '2.0',
      id,
      result: modern ? { resultType: 'complete', ...result } : result,
    });

  switch (method) {
    case 'server/discover':
      return done({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return done({});
    case 'tools/list':
      return done({ tools: TOOLS });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || !TOOLS.some((t) => t.name === name)) {
        return rpcError(id, INVALID_PARAMS, 'Unknown tool', modern ? 400 : 200);
      }
      const result = await deps.call(name, params.arguments ?? {});
      return done({ ...result });
    }
    default:
      return rpcError(
        id,
        METHOD_NOT_FOUND,
        'Method not found',
        modern ? 404 : 200,
      );
  }
}
