/**
 * Worker ⇄ `OrgHub` for MCP: a tool call (or "make my MCP device") for
 * the grant's (user, org), with the caller in the same trusted header the
 * fleet routes use (incoming copies are never forwarded: the Worker builds
 * these requests itself).
 *
 * ```text
 * Worker: grant {userId, orgId} ─▶ OrgHub(idFromName(orgId))
 *   POST /mcp/call   {name, arguments} ─▶ McpFleet ─▶ ToolResult
 *   POST /mcp/enable                   ─▶ the MCP device made (and online)
 * ```
 */
import { CloudError } from '../errors';
import type { FleetCaller } from '../fleet/hub';
import { CALLER_HEADER, type HubFor } from '../fleet/route';
import { McpError, type McpFleet } from './fleet';
import { callTool, type ToolResult } from './tools';

export const MCP_CALL_PATH = '/mcp/call';
export const MCP_ENABLE_PATH = '/mcp/enable';

/** What the Worker knows about the grant behind an MCP token. */
export interface McpGrant {
  userId: string;
  orgId: string;
}

function hubRequest(
  origin: string,
  path: string,
  grant: McpGrant,
  body: unknown,
): Request {
  const caller: FleetCaller = {
    userId: grant.userId,
    orgId: grant.orgId,
    expMs: 0,
  };
  return new Request(new URL(path, origin), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [CALLER_HEADER]: JSON.stringify(caller),
    },
    body: JSON.stringify(body),
  });
}

/** A tool call, run in the org's hub. */
export async function callInHub(
  hubFor: HubFor | undefined,
  origin: string,
  grant: McpGrant,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  if (!hubFor) {
    throw new CloudError(500, 'cloud.config', 'the fleet is not configured');
  }
  const res = await hubFor(grant.orgId).fetch(
    hubRequest(origin, MCP_CALL_PATH, grant, { name, arguments: args }),
  );
  if (!res.ok) {
    throw new CloudError(502, 'cloud.internal', 'the MCP device failed');
  }
  return (await res.json()) as ToolResult;
}

/** The user's MCP device made at sign-in (best effort: tools make it too). */
export async function enableInHub(
  hubFor: HubFor | undefined,
  origin: string,
  grant: McpGrant,
): Promise<void> {
  if (!hubFor) return;
  try {
    await hubFor(grant.orgId).fetch(
      hubRequest(origin, MCP_ENABLE_PATH, grant, {}),
    );
  } catch {
    // The first tool call makes it.
  }
}

/** Inside the DO: a tool call or an enable for `caller`. */
export async function answerMcp(
  fleet: McpFleet | null,
  caller: FleetCaller,
  request: Request,
): Promise<Response> {
  if (!fleet) {
    return Response.json(
      { error: { code: 'cloud.config', message: 'MCP is not configured' } },
      { status: 500 },
    );
  }
  const c = { userId: caller.userId, orgId: caller.orgId };
  const path = new URL(request.url).pathname;
  try {
    if (path === MCP_ENABLE_PATH) {
      await fleet.online(c);
      return Response.json({ ok: true });
    }
    const body = (await request.json()) as {
      name?: unknown;
      arguments?: unknown;
    };
    if (typeof body.name !== 'string') {
      return Response.json(
        { error: { code: 'cloud.bad_request', message: 'name is required' } },
        { status: 400 },
      );
    }
    return Response.json(await callTool(fleet, c, body.name, body.arguments));
  } catch (e) {
    if (e instanceof McpError) {
      return Response.json({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: { code: e.code, message: e.message },
            }),
          },
        ],
        isError: true,
      } satisfies ToolResult);
    }
    console.error('mcp.internal', e instanceof Error ? e.name : typeof e);
    return Response.json(
      { error: { code: 'cloud.internal', message: 'internal error' } },
      { status: 500 },
    );
  }
}
