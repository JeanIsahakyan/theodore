/**
 * Agent, model and effort on another device (docs/fleet.md "Agent, model
 * and effort"): what a host lists (`FleetDeviceView.agents`), what runs
 * there, and what a start or send names. Like the desktop's chip for a
 * remote space: only what was picked goes; the host's defaults (a start)
 * or the space's own (a send) run for the rest. A host that lists none
 * gets nothing.
 *
 * ```text
 * pick {agent?, model?, effort?}  ─▶ running(): what the chip shows
 *                                 ─▶ startPicks() / sendPicks(): what goes
 * agent picked  ─▶ model and effort reset
 * model picked  ─▶ an effort it doesn't take is dropped
 * ```
 */
import type {
  AgentPicks,
  FleetAgentView,
  FleetModelView,
} from '../fleet/types';

/** Claude Code's multi-agent effort: offered wherever a Claude model takes
 *  a level (the host accepts it there too). */
export const ULTRACODE = 'ultracode';

/** A pick, each part `null` until chosen. */
export interface Pick {
  agent: string | null;
  model: string | null;
  effort: string | null;
}

export const NO_PICK: Pick = { agent: null, model: null, effort: null };

/** What runs, as the chip shows it. */
export interface Running {
  agent: FleetAgentView;
  /** The listed model in effect; `null` when it isn't listed. */
  model: FleetModelView | null;
  /** The model in effect as named (listed or not); `null`: the CLI's own. */
  modelId: string | null;
  /** Levels the model in effect takes (Ultracode last for Claude). */
  levels: string[];
  effort: string | null;
}

const EFFORT_LABEL: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
  [ULTRACODE]: 'Ultracode',
};

/** "xhigh" → "Extra high"; an unknown level capitalized. */
export function effortLabel(effort: string): string {
  return (
    EFFORT_LABEL[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1)
  );
}

/** The listed model `id` names: itself, else the newest of the family an
 *  alias names (`opus`), as the host reads it. */
export function listedModel(
  models: readonly FleetModelView[],
  id: string | null,
): FleetModelView | null {
  if (!id) return null;
  return (
    models.find((m) => m.id === id) ??
    models.find((m) => m.id.includes(id)) ??
    null
  );
}

/** Levels `model` takes for `agent`. */
export function levelsOf(
  agent: FleetAgentView,
  model: FleetModelView | null,
): string[] {
  const own = model?.efforts ?? [];
  return agent.id === 'claude' && own.length > 0 && !own.includes(ULTRACODE)
    ? [...own, ULTRACODE]
    : own;
}

/**
 * What runs on a host listing `agents` with `pick`, given the space's own
 * (`current`, from its mirrored row; `NO_PICK` for a new space). `null`
 * when the host lists no agents.
 *
 * Agent: the pick, else the space's, else the host's default (first).
 * Model: the pick, else the space's while its agent stays, else the
 * agent's default, else its first. Effort: the first the model takes of
 * the pick, the space's (same agent, model not picked), the agent's
 * default, the model's own, `medium`, its first level.
 */
export function running(
  agents: readonly FleetAgentView[],
  pick: Pick,
  current: Pick = NO_PICK,
): Running | null {
  const find = (id: string | null) =>
    id ? (agents.find((a) => a.id === id) ?? null) : null;
  const agent = find(pick.agent) ?? find(current.agent) ?? agents[0];
  if (!agent) return null;
  const same = agent.id === current.agent;
  const picked = listedModel(agent.models, pick.model);
  const modelId =
    picked?.id ??
    (same ? current.model : null) ??
    agent.defaultModel ??
    agent.models[0]?.id ??
    null;
  const model =
    picked ??
    listedModel(agent.models, modelId) ??
    (modelId ? null : (agent.models[0] ?? null));
  const levels = levelsOf(agent, model);
  const effort =
    [
      pick.effort,
      same && !picked ? current.effort : null,
      agent.defaultEffort,
      model?.defaultEffort,
      'medium',
      levels[0],
    ].find((e): e is string => !!e && levels.includes(e)) ?? null;
  return { agent, model, modelId: model?.id ?? modelId, levels, effort };
}

/** The chip's text: "Opus 4.1 · High", the agent when no model is named. */
export function runningLabel(r: Running): string {
  const { model, effort } = runningParts(r);
  return effort ? `${model} · ${effort}` : model;
}

/** The chip's two parts: the model, and the effort drawn muted. */
export function runningParts(r: Running): {
  model: string;
  effort: string | null;
} {
  return {
    model: r.model?.label ?? r.modelId ?? r.agent.label,
    effort: r.effort ? effortLabel(r.effort) : null,
  };
}

/** For screen readers: "Claude, Opus 4.1, High". */
export function runningA11y(r: Running): string {
  return [
    r.agent.label,
    r.model?.label ?? r.modelId ?? 'default model',
    ...(r.effort ? [effortLabel(r.effort)] : []),
  ].join(', ');
}

/** Another agent picked: its model and effort start from its defaults. */
export function pickAgent(agent: string): Pick {
  return { agent, model: null, effort: null };
}

/** Another model picked for the agent shown: an effort it doesn't take is
 *  dropped. The agent stays as picked (none: what's shown runs it). */
export function pickModel(
  agents: readonly FleetAgentView[],
  pick: Pick,
  current: Pick,
  model: string | null,
): Pick {
  const now = running(agents, { ...pick, model }, current);
  if (!now) return pick;
  const effort =
    pick.effort && now.levels.includes(pick.effort) ? pick.effort : null;
  return { agent: pick.agent, model, effort };
}

/** A level picked (`null`: back to the default) for what's shown. */
export function pickEffort(pick: Pick, effort: string | null): Pick {
  return { ...pick, effort };
}

/** Only parts still listed: a host may drop an agent or model meanwhile. */
function listed(
  agents: readonly FleetAgentView[],
  pick: Pick,
  current: Pick,
): Pick {
  if (pick.agent && !agents.some((a) => a.id === pick.agent)) return NO_PICK;
  const of = running(agents, { ...pick, model: null, effort: null }, current);
  const model =
    pick.model && of?.agent.models.some((m) => m.id === pick.model)
      ? pick.model
      : null;
  return { agent: pick.agent, model, effort: pick.effort };
}

/**
 * What a start names: once anything is picked, the agent shown (the pick,
 * else the host's default, then named) with the model and effort picked;
 * else nothing, and the host's defaults run.
 */
export function startPicks(
  agents: readonly FleetAgentView[],
  pick: Pick,
): AgentPicks {
  if (!agents.length) return {};
  const p = listed(agents, pick, NO_PICK);
  if (!p.agent && !p.model && !p.effort) return {};
  const now = running(agents, p);
  if (!now) return {};
  return {
    agent: now.agent.id,
    ...(p.model ? { model: p.model } : {}),
    ...(p.effort && now.levels.includes(p.effort) ? { effort: p.effort } : {}),
  };
}

/**
 * What a send names from this turn on: what was picked, the agent only
 * when it isn't the space's own; nothing picked keeps the space's.
 */
export function sendPicks(
  agents: readonly FleetAgentView[],
  pick: Pick,
  current: Pick,
): AgentPicks {
  if (!agents.length) return {};
  const p = listed(agents, pick, current);
  if (!p.agent && !p.model && !p.effort) return {};
  const now = running(agents, p, current);
  if (!now) return {};
  const out: AgentPicks = {};
  if (now.agent.id !== current.agent) out.agent = now.agent.id;
  if (p.model) out.model = p.model;
  if (p.effort && now.levels.includes(p.effort)) out.effort = p.effort;
  return out;
}

/** The space's own agent, model and effort, from its mirrored row. */
export function spaceOwn(
  row:
    | { agent?: string; model?: string | null; effort?: string | null }
    | null
    | undefined,
): Pick {
  return {
    agent: row?.agent || null,
    model: row?.model ?? null,
    effort: row?.effort ?? null,
  };
}
