// MCP over Streamable HTTP: the legacy `initialize` era and the modern
// per-request one (2026-07-28), header checks, no sessions.
import { describe, expect, it } from 'vitest';
import type { Loose } from './loose';
import {
  handleRpc,
  headerValue,
  LEGACY_VERSIONS,
  MODERN_VERSION,
} from '../src/mcp/rpc';
import { TOOLS } from '../src/mcp/tools';

const calls: { name: string; args: unknown }[] = [];
const deps = {
  call: async (name: string, args: unknown) => {
    calls.push({ name, args });
    return { content: [{ type: 'text' as const, text: '{"ok":true}' }] };
  },
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return handleRpc(
    new Request('https://cloud.test/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    deps,
  );
}

const meta = (v = MODERN_VERSION) => ({
  'io.modelcontextprotocol/protocolVersion': v,
  'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
});

describe('legacy (initialize)', () => {
  it('initializes, lists and calls tools without a session', async () => {
    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-code', version: '2' },
      },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get('mcp-session-id')).toBeNull();
    const r = (await init.json()) as Loose;
    expect(r.result.protocolVersion).toBe('2025-06-18');
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.serverInfo.name).toBe('theodore');

    const unknownVersion = (await (
      await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-01-01' },
      })
    ).json()) as Loose;
    expect(unknownVersion.result.protocolVersion).toBe(LEGACY_VERSIONS[0]);

    expect(
      (
        await post(
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { 'mcp-protocol-version': '2025-06-18' },
        )
      ).status,
    ).toBe(202);

    const list = (await (
      await post(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { 'mcp-protocol-version': '2025-06-18' },
      )
    ).json()) as Loose;
    expect(list.result.tools.map((t) => t.name)).toEqual([
      'theodore_status',
      'devices_list',
      'device_trust',
      'projects_list',
      'spaces_list',
      'space_start',
      'space_send',
      'space_read',
      'space_wait',
      'space_stop',
      'ask_answer',
      'plan_approve',
      'computer_spaces',
      'computer_space_read',
      'space_ask',
      'space_answer',
      'space_merge',
    ]);
    expect(list.result.resultType).toBeUndefined();

    calls.length = 0;
    const call = (await (
      await post({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'theodore_status', arguments: {} },
      })
    ).json()) as Loose;
    expect(call.result.content[0].text).toBe('{"ok":true}');
    expect(calls).toEqual([{ name: 'theodore_status', args: {} }]);
  });

  it('refuses unknown tools and methods, GET and DELETE', async () => {
    const t = (await (
      await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'rm_rf' },
      })
    ).json()) as Loose;
    expect(t.error.code).toBe(-32602);
    const m = (await (
      await post({ jsonrpc: '2.0', id: 2, method: 'resources/list' })
    ).json()) as Loose;
    expect(m.error.code).toBe(-32601);
    for (const method of ['GET', 'DELETE']) {
      const r = await handleRpc(
        new Request('https://cloud.test/mcp', { method }),
        deps,
      );
      expect(r.status).toBe(405);
    }
    expect((await post('[{"jsonrpc":"2.0"}]')).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
  });

  it('describes the trust rules in the tools', () => {
    const start = TOOLS.find((t) => t.name === 'space_start')!;
    expect(start.description).toContain('fleet.denied');
    expect(start.description).toContain('up to 5 minutes');
    expect(TOOLS.find((t) => t.name === 'device_trust')!.description).toContain(
      'never guess',
    );
  });
});

describe('modern (2026-07-28)', () => {
  const headers = (method: string, name?: string) => ({
    'mcp-protocol-version': MODERN_VERSION,
    'mcp-method': method,
    ...(name ? { 'mcp-name': name } : {}),
  });

  it('discovers and calls with matching headers', async () => {
    const d = (await (
      await post(
        {
          jsonrpc: '2.0',
          id: 'd',
          method: 'server/discover',
          params: { _meta: meta() },
        },
        headers('server/discover'),
      )
    ).json()) as Loose;
    expect(d.result.resultType).toBe('complete');
    expect(d.result.supportedVersions).toContain(MODERN_VERSION);
    expect(d.result.capabilities.tools).toEqual({});

    calls.length = 0;
    const r = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'spaces_list', arguments: {}, _meta: meta() },
      },
      headers('tools/call', '=?base64?c3BhY2VzX2xpc3Q=?='),
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as Loose).result.resultType).toBe('complete');
    expect(calls.map((c) => c.name)).toEqual(['spaces_list']);
  });

  it('refuses mismatched headers and unknown versions', async () => {
    const mismatch = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'spaces_list', _meta: meta() },
      },
      headers('tools/call', 'devices_list'),
    );
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as Loose).error.code).toBe(-32020);

    const missing = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: meta() },
      },
      { 'mcp-protocol-version': MODERN_VERSION },
    );
    expect(((await missing.json()) as Loose).error.code).toBe(-32020);

    const version = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: meta('2099-01-01') },
      },
      { 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'tools/list' },
    );
    expect(version.status).toBe(400);
    const v = (await version.json()) as Loose;
    expect(v.error.code).toBe(-32022);
    expect(v.error.data.supported).toContain(MODERN_VERSION);

    const unknown = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'prompts/list',
        params: { _meta: meta() },
      },
      headers('prompts/list'),
    );
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as Loose).error.code).toBe(-32601);
  });

  it('decodes base64 header values', () => {
    expect(headerValue('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe('Hello, 世界');
    expect(headerValue('plain')).toBe('plain');
  });
});
