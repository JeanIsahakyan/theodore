/**
 * `OrgHub`: one Durable Object per `org_id` (`idFromName`), a thin shell
 * over [`Hub`]. Sockets use the Hibernation API, so an idle fleet bills
 * nothing: each socket's state is its attachment, the rest is SQLite.
 *
 * ```text
 * Worker (verified JWT) ─▶ fetch + x-theodore-fleet-caller ─▶ acceptWebSocket(tag u:<user>)
 *                        └─ POST /v1/fleet/request ─▶ Hub.requestOverHttp ─▶ 202 │ 200 refused
 * webSocketMessage / webSocketClose / alarm ─▶ Hub ─▶ pushes (Expo) via ctx.waitUntil
 * Worker /mcp (OAuth grant: user, org) ─▶ POST /mcp/call ─▶ McpFleet: the
 *   user's MCP device, connected to the same Hub in process (src/mcp/)
 * Worker DELETE /v1/account ─▶ POST /v1/account/purge ─▶ the user's rows (or,
 *   a personal org, all) gone; that user refused on every path for a day
 * ```
 *
 * Not reachable from the internet: only the Worker holds the binding, and it
 * strips any incoming caller header, so the header is trusted here.
 *
 * Heartbeat: the device sends WebSocket ping frames; the runtime answers
 * them without waking the object and they never reach `webSocketMessage`.
 * The hub sends no pings of its own (an alarm every 15 s would defeat
 * hibernation).
 */
import { verifierFor } from '../auth';
import { McpFleet } from '../mcp/fleet';
import { MCP_CALL_PATH, MCP_ENABLE_PATH, answerMcp } from '../mcp/route';
import { McpStore } from '../mcp/store';
import {
  telemetryFor,
  type TelemetryEnv,
  type Telemetry,
} from '../telemetry/cloud';
import { Hub, type Conn, type ConnState, type FleetCaller } from './hub';
import { expoSender } from './push';
import {
  answerPurge,
  answerRequest,
  BEARER_PROTOCOL,
  CALLER_HEADER,
  PURGE_PATH,
  REQUEST_PATH,
  type McpPurge,
} from './route';

export { CALLER_HEADER };

export interface OrgHubEnv extends TelemetryEnv {
  WORKOS_CLIENT_ID: string;
  WORKOS_API_BASE?: string;
  /** Expo's access token, if the project has "enhanced push security" on. */
  EXPO_ACCESS_TOKEN?: string;
  /** Wraps the MCP devices' keys at rest; absent: MCP is off. */
  MCP_KEY_WRAP?: string;
}

const userTag = (userId: string) => `u:${userId}`;

function wrap(ws: WebSocket): Conn {
  return {
    get open() {
      return ws.readyState === 1;
    },
    state: () => ws.deserializeAttachment() as ConnState,
    save: (s) => ws.serializeAttachment(s),
    send: (t) => ws.send(t),
    close: (code, reason) => ws.close(code, reason),
  };
}

export function readCaller(header: string | null): FleetCaller | null {
  if (!header) return null;
  try {
    const c = JSON.parse(header) as Partial<FleetCaller>;
    if (
      typeof c.userId !== 'string' ||
      typeof c.orgId !== 'string' ||
      typeof c.expMs !== 'number'
    ) {
      return null;
    }
    return {
      userId: c.userId,
      orgId: c.orgId,
      sessionId: c.sessionId,
      expMs: c.expMs,
    };
  } catch {
    return null;
  }
}

export class OrgHub implements DurableObject {
  private hub: Hub;
  private mcp: McpFleet | null;
  private mcpPurge: McpPurge;
  private telemetry: Telemetry;
  /** The alarm as last set; undefined until read after a wake. */
  private alarmAt: number | null | undefined;

  constructor(
    private ctx: DurableObjectState,
    env: OrgHubEnv,
  ) {
    const verify = verifierFor(
      env.WORKOS_API_BASE ?? 'https://api.workos.com',
      env.WORKOS_CLIENT_ID,
    );
    this.telemetry = telemetryFor(env);
    const log = this.telemetry.log.child({ component: 'org_hub' });
    const sql = {
      exec: (q: string, ...b: (string | number | null)[]) =>
        ctx.storage.sql.exec(q, ...b).toArray() as Record<string, unknown>[],
    };
    this.mcp = env.MCP_KEY_WRAP
      ? new McpFleet({
          sql,
          now: () => Date.now(),
          hub: () => this.hub,
          secret: env.MCP_KEY_WRAP,
        })
      : null;
    this.hub = new Hub({
      sql,
      now: () => Date.now(),
      conns: (user) => [
        ...ctx
          .getWebSockets(user === undefined ? undefined : userTag(user))
          .map(wrap),
        ...(this.mcp?.conns(user) ?? []),
      ],
      verify,
      schedule: (at) => this.schedule(at),
      push: expoSender(
        (input, init) => fetch(input, init),
        env.EXPO_ACCESS_TOKEN,
        log,
      ),
      defer: (work) => ctx.waitUntil(work),
      log,
    });
    // MCP off now doesn't mean its tables never held rows.
    const mcpStore = () => this.mcp?.store ?? new McpStore(sql);
    this.mcpPurge = {
      user: (u) => (this.mcp ? this.mcp.forget(u) : mcpStore().purgeUser(u)),
      all: () => mcpStore().purgeAll(),
    };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.serve(request);
    } finally {
      this.flushLogs();
    }
  }

  /** The cloud's records out, after the work (never awaited here). */
  private flushLogs() {
    this.ctx.waitUntil(this.telemetry.flush());
  }

  private async serve(request: Request): Promise<Response> {
    const caller = readCaller(request.headers.get(CALLER_HEADER));
    if (!caller) return new Response('no caller', { status: 400 });
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === PURGE_PATH) {
      // The alarm stays: it drops the `gone_users` row when it lapses.
      return answerPurge(this.hub, this.mcpPurge, caller, request);
    }
    // A deleted account: no socket, request or MCP call brings rows back.
    if (this.hub.isGone(caller.userId)) {
      return Response.json(
        {
          error: {
            code: 'fleet.unauthorized',
            message: 'the account was deleted',
          },
        },
        { status: 401 },
      );
    }
    if (request.method === 'POST' && path === REQUEST_PATH) {
      return answerRequest(this.hub, caller, request);
    }
    if (
      request.method === 'POST' &&
      (path === MCP_CALL_PATH || path === MCP_ENABLE_PATH)
    ) {
      return answerMcp(this.mcp, caller, request);
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [userTag(caller.userId)]);
    await this.hub.open(wrap(server), caller);
    // A browser's token came as a subprotocol: the 101 must pick one it
    // offered (the Worker left just that one in the header).
    const echo = request.headers.get('sec-websocket-protocol');
    const picks =
      echo !== null &&
      (echo === BEARER_PROTOCOL || echo.startsWith(`${BEARER_PROTOCOL}.`));
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: picks ? { 'sec-websocket-protocol': echo } : undefined,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      await this.hub.message(wrap(ws), message);
    } finally {
      this.flushLogs();
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      // Finish the close handshake (1005/1006 can't be sent back).
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed');
    } catch {
      // already closed
    }
    try {
      await this.hub.closed(wrap(ws), code);
    } finally {
      this.flushLogs();
    }
  }

  async webSocketError(ws: WebSocket) {
    try {
      await this.hub.closed(wrap(ws));
    } finally {
      this.flushLogs();
    }
  }

  async alarm() {
    this.alarmAt = null;
    try {
      await this.hub.alarm();
    } finally {
      this.flushLogs();
    }
  }

  /** Sets the alarm only when it moves earlier: one write, not one a message. */
  private async schedule(at: number | null) {
    if (at === null) return; // a stale alarm just finds nothing due
    if (this.alarmAt === undefined) {
      this.alarmAt = await this.ctx.storage.getAlarm();
    }
    if (this.alarmAt !== null && this.alarmAt <= at) return;
    await this.ctx.storage.setAlarm(at);
    this.alarmAt = at;
  }
}
