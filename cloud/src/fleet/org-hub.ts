/**
 * `OrgHub`: one Durable Object per `org_id` (`idFromName`), a thin shell
 * over [`Hub`]. Sockets use the Hibernation API, so an idle fleet bills
 * nothing: each socket's state is its attachment, the rest is SQLite.
 *
 * ```text
 * Worker (verified JWT) ─▶ fetch + x-theodore-fleet-caller ─▶ acceptWebSocket(tag u:<user>)
 * webSocketMessage / webSocketClose / alarm ─▶ Hub
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
import { Hub, type Conn, type ConnState, type FleetCaller } from './hub';

export const CALLER_HEADER = 'x-theodore-fleet-caller';

export interface OrgHubEnv {
  WORKOS_CLIENT_ID: string;
  WORKOS_API_BASE?: string;
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
    this.hub = new Hub({
      sql: {
        exec: (q, ...b) =>
          ctx.storage.sql.exec(q, ...b).toArray() as Record<string, unknown>[],
      },
      now: () => Date.now(),
      conns: (user) =>
        ctx
          .getWebSockets(user === undefined ? undefined : userTag(user))
          .map(wrap),
      verify,
      schedule: (at) => this.schedule(at),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const caller = readCaller(request.headers.get(CALLER_HEADER));
    if (!caller) return new Response('no caller', { status: 400 });
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [userTag(caller.userId)]);
    await this.hub.open(wrap(server), caller);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    await this.hub.message(wrap(ws), message);
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      // Finish the close handshake (1005/1006 can't be sent back).
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed');
    } catch {
      // already closed
    }
    await this.hub.closed(wrap(ws));
  }

  async webSocketError(ws: WebSocket) {
    await this.hub.closed(wrap(ws));
  }

  async alarm() {
    this.alarmAt = null;
    await this.hub.alarm();
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
