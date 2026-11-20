/**
 * The MCP tools (docs/fleet.md "MCP over the cloud"): their definitions
 * for `tools/list` (static, the Worker answers it) and the calls (in the
 * org's `OrgHub`, over `McpFleet`).
 *
 * A result is JSON text. A refusal is `isError` with a code: the cloud's
 * own (`mcp.*`) with fixed words, a computer's or the cloud's fleet
 * refusal (`fleet.*`) as its code only.
 */
import type { FleetMode } from '../gen/fleet';
import {
  MAX_TEXT_CHARS,
  MAX_WAIT_MS,
  McpError,
  type McpCaller,
  type McpFleet,
  type Sent,
} from './fleet';
import { isMode, MODES, validDeviceId, validSpaceId } from './text';

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const TRUST_NOTE =
  'Theodore runs nothing on a computer on the cloud’s word: the computer must trust this MCP connection (the user compares its fingerprint from theodore_status on the computer’s Devices screen), and this connection reaches only computers trusted here with device_trust.';

const APPROVAL_NOTE =
  'Its key lives in the cloud, so the computer caps it: Ask and Plan run directly; Edit and Run, and approving a plan, wait for a person to say yes on that computer. A no, or no answer in time, comes back as the refusal code fleet.denied.';

const device = {
  type: 'string',
  description: 'A computer’s device id (dev_…), from devices_list.',
};
const space = {
  type: 'string',
  description: 'A space id (rs_…) returned by space_start.',
};
const mode = {
  type: 'string',
  enum: MODES,
  description:
    'ask: answers only; plan: explores and proposes a plan to approve; edit: changes files; run: also runs commands.',
};

export const TOOLS: ToolDef[] = [
  {
    name: 'theodore_status',
    title: 'Theodore status',
    description: `This MCP connection's own fleet device (id, name, fingerprint), the organization, and the user's computers with whether each is trusted here. ${TRUST_NOTE} To let a computer take requests from Claude, the user opens Theodore → Devices on it, finds "Claude (MCP)" and trusts it after checking that the fingerprint shown there is this one.`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'devices_list',
    title: 'List computers',
    description:
      'The user’s computers in this organization (never phones or browsers): id, name, online, whether trusted here, whether it takes remote spaces and its highest mode. Fingerprints are not listed on purpose: trusting a computer needs the one the user reads on it.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'device_trust',
    title: 'Trust a computer',
    description:
      'Trust a computer for requests from this MCP connection. Ask the user to read the fingerprint on that computer (Theodore → Devices, "This device") and pass exactly what they read; never guess it or take it from anywhere else. Refused unless it matches the computer’s key.',
    inputSchema: {
      type: 'object',
      properties: {
        device,
        fingerprint: {
          type: 'string',
          description: '32 hex digits in 8 groups, as the computer shows it.',
        },
      },
      required: ['device', 'fingerprint'],
    },
  },
  {
    name: 'projects_list',
    title: 'List a computer’s projects',
    description:
      'The projects a computer lets remote spaces start in (ids to pass to space_start), and the agents, models and efforts it offers.',
    inputSchema: {
      type: 'object',
      properties: { device },
      required: ['device'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'spaces_list',
    title: 'List spaces',
    description:
      'Spaces started through this MCP connection, newest first, with their status.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'space_start',
    title: 'Start a space',
    description: `Start a space (an agent working in its own branch) on a trusted computer, in one of its projects, with a goal and a mode. Returns its id. ${APPROVAL_NOTE} Follow it with space_wait and space_read.`,
    inputSchema: {
      type: 'object',
      properties: {
        device,
        project: {
          type: 'string',
          description: 'A project id from projects_list.',
        },
        goal: { type: 'string', description: 'What the agent should do.' },
        mode,
        agent: {
          type: 'string',
          description:
            'An agent id from projects_list; default: the computer’s.',
        },
        model: { type: 'string', description: 'A model id of that agent.' },
        effort: { type: 'string', description: 'An effort of that model.' },
      },
      required: ['device', 'project', 'goal', 'mode'],
    },
  },
  {
    name: 'space_send',
    title: 'Send to a space',
    description: `Send the next message to a space once it settled (not while its agent works: fleet.busy). mode: for this turn and on, default the space's. ${APPROVAL_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: { space, message: { type: 'string' }, mode },
      required: ['space', 'message'],
    },
  },
  {
    name: 'space_read',
    title: 'Read a space',
    description:
      'A space’s status, name, branch, last reply, open question (answer with ask_answer), plan waiting for approval (plan_approve), last refusal code, and its recent history (after `since`, a seq).',
    inputSchema: {
      type: 'object',
      properties: {
        space,
        since: {
          type: 'integer',
          minimum: 0,
          description: 'Lines after this seq.',
        },
      },
      required: ['space'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'space_wait',
    title: 'Wait for spaces',
    description: `Wait until each space is idle, waiting for an answer, stopped or failed, at most timeout_ms (≤ ${MAX_WAIT_MS}); call again to keep waiting.`,
    inputSchema: {
      type: 'object',
      properties: {
        spaces: { type: 'array', items: space, minItems: 1, maxItems: 20 },
        timeout_ms: { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS },
      },
      required: ['spaces'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'space_stop',
    title: 'Stop a space',
    description: 'Stop the turn running in a space.',
    inputSchema: {
      type: 'object',
      properties: { space },
      required: ['space'],
    },
  },
  {
    name: 'ask_answer',
    title: 'Answer a question',
    description:
      'Answer the question a space’s agent asked (space_read shows it with its `ask` id). answer: one string for a single question (an option’s text, or free text), or a list with one entry per question, each a string or a list of options.',
    inputSchema: {
      type: 'object',
      properties: {
        space,
        ask: { type: 'string', description: 'The question’s ask id.' },
        answer: {
          anyOf: [
            { type: 'string' },
            {
              type: 'array',
              items: {
                anyOf: [
                  { type: 'string' },
                  { type: 'array', items: { type: 'string' } },
                ],
              },
            },
          ],
        },
      },
      required: ['space', 'ask', 'answer'],
    },
  },
  {
    name: 'plan_approve',
    title: 'Approve a plan',
    description: `Approve the plan of a Plan-mode space's last turn: its agent implements it in Edit (or Run, if the space used Run). ${APPROVAL_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: { space },
      required: ['space'],
    },
  },
];

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

const ok = (v: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(v, null, 2) }],
});

const refusal = (code: string, message: string): ToolResult => ({
  content: [
    { type: 'text', text: JSON.stringify({ error: { code, message } }) },
  ],
  isError: true,
});

type Args = Record<string, unknown>;

function needStr(a: Args, k: string, max: number): string {
  const v = a[k];
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) {
    throw new McpError('mcp.invalid', `${k} must be a non-empty string`);
  }
  return v;
}

function optStr(a: Args, k: string, max: number): string | null {
  const v = a[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v === '' || v.length > max) {
    throw new McpError('mcp.invalid', `${k} must be a string`);
  }
  return v;
}

function needDevice(a: Args): string {
  const v = a.device;
  if (!validDeviceId(v)) {
    throw new McpError('mcp.invalid', 'device must be a device id (dev_…)');
  }
  return v;
}

function needSpace(v: unknown): string {
  if (!validSpaceId(v)) {
    throw new McpError('mcp.invalid', 'space must be a space id (rs_…)');
  }
  return v;
}

function needMode(v: unknown, optional: true): FleetMode | null;
function needMode(v: unknown, optional?: false): FleetMode;
function needMode(v: unknown, optional = false): FleetMode | null {
  if (optional && (v === undefined || v === null)) return null;
  if (!isMode(v)) {
    throw new McpError(
      'mcp.invalid',
      `mode must be one of ${MODES.join(', ')}`,
    );
  }
  return v;
}

/** `answer` as the wire's `answers`: one list of strings per question. */
export function answersOf(v: unknown): string[][] {
  const text = (s: unknown) => {
    if (typeof s !== 'string' || s.trim() === '' || s.length > 4000) {
      throw new McpError('mcp.invalid', 'an answer must be a non-empty string');
    }
    return s;
  };
  if (typeof v === 'string') return [[text(v)]];
  if (!Array.isArray(v) || v.length === 0 || v.length > 20) {
    throw new McpError('mcp.invalid', 'answer must be a string or a list');
  }
  return v.map((x) => {
    if (Array.isArray(x)) {
      if (x.length === 0 || x.length > 50) {
        throw new McpError('mcp.invalid', 'pick at least one option');
      }
      return x.map(text);
    }
    return [text(x)];
  });
}

/** What a sent request came to, as a tool says it. */
function sentResult(
  sent: Sent,
  extra: Record<string, unknown> = {},
): ToolResult {
  switch (sent.state) {
    case 'ok':
      return ok({ ...extra, result: 'ok' });
    case 'refused':
      return refusal(
        sent.code,
        sent.by === 'computer'
          ? `the computer refused: ${sent.code}`
          : `refused by the cloud: ${sent.code}`,
      );
    case 'pending':
      return ok({
        ...extra,
        result: 'pending',
        note: 'no answer from the computer yet: an Edit or Run request from Claude waits for a person’s yes there. Check with space_wait or space_read.',
      });
  }
}

export async function callTool(
  fleet: McpFleet,
  c: McpCaller,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const a: Args =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Args)
      : {};
  try {
    switch (name) {
      case 'theodore_status':
        return ok(await fleet.status(c));
      case 'devices_list':
        return ok({ computers: await fleet.devices(c) });
      case 'device_trust':
        return ok(
          await fleet.trust(c, needDevice(a), needStr(a, 'fingerprint', 100)),
        );
      case 'projects_list':
        return ok(await fleet.projects(c, needDevice(a)));
      case 'spaces_list':
        return ok({ spaces: await fleet.spaces(c) });
      case 'space_start': {
        const out = await fleet.start(c, {
          device: needDevice(a),
          project: needStr(a, 'project', 100),
          goal: needStr(a, 'goal', MAX_TEXT_CHARS),
          mode: needMode(a.mode),
          agent: optStr(a, 'agent', 32),
          model: optStr(a, 'model', 64),
          effort: optStr(a, 'effort', 16),
        });
        if (out.sent.state === 'refused') return sentResult(out.sent);
        return sentResult(out.sent, { space: out.space });
      }
      case 'space_send': {
        const space = needSpace(a.space);
        return sentResult(
          await fleet.message(
            c,
            space,
            needStr(a, 'message', MAX_TEXT_CHARS),
            needMode(a.mode, true),
          ),
          { space },
        );
      }
      case 'space_read': {
        const since = a.since === undefined ? 0 : a.since;
        if (typeof since !== 'number' || !Number.isSafeInteger(since)) {
          throw new McpError('mcp.invalid', 'since must be an integer');
        }
        return ok(await fleet.read(c, needSpace(a.space), Math.max(0, since)));
      }
      case 'space_wait': {
        const spaces = a.spaces;
        if (
          !Array.isArray(spaces) ||
          spaces.length === 0 ||
          spaces.length > 20
        ) {
          throw new McpError('mcp.invalid', 'spaces must list 1 to 20 spaces');
        }
        const t = a.timeout_ms === undefined ? MAX_WAIT_MS : a.timeout_ms;
        if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
          throw new McpError('mcp.invalid', 'timeout_ms must be ≥ 0');
        }
        return ok(
          await fleet.wait(
            c,
            [...new Set(spaces.map(needSpace))],
            Math.min(t, MAX_WAIT_MS),
          ),
        );
      }
      case 'space_stop': {
        const space = needSpace(a.space);
        return sentResult(await fleet.stop(c, space), { space });
      }
      case 'ask_answer': {
        const space = needSpace(a.space);
        return sentResult(
          await fleet.answer(
            c,
            space,
            needStr(a, 'ask', 128),
            answersOf(a.answer),
          ),
          { space },
        );
      }
      case 'plan_approve': {
        const space = needSpace(a.space);
        return sentResult(await fleet.approve(c, space), { space });
      }
      default:
        return refusal('mcp.unknown_tool', 'no such tool');
    }
  } catch (e) {
    if (e instanceof McpError) return refusal(e.code, e.message);
    throw e;
  }
}
