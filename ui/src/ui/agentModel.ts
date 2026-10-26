/**
 * Which model and effort an agent runs with: `agents.<id>.model` and
 * `agents.<id>.effort`, `user` scope. Unset = the CLI's own default. The
 * core fills them into every run that doesn't name its own model.
 */
import type { AgentId } from '../gen/contract';
import { setSetting } from '../actions';
import type { RootStore } from '../stores/RootStore';

type Store = Pick<RootStore, 'models'>;

export type Choice = { id: string; label: string; hint?: string };

/** Claude Code's `--model` aliases (latest model of each family). */
export const CLAUDE_MODELS: Choice[] = [
  { id: 'fable', label: 'Fable', hint: 'Newest' },
  { id: 'opus', label: 'Opus', hint: 'Deep reasoning' },
  { id: 'sonnet', label: 'Sonnet', hint: 'Balanced' },
  { id: 'haiku', label: 'Haiku', hint: 'Fastest, cheapest' },
];

/** Claude Code's `--effort` levels, as `claude --help` lists them. */
export const EFFORTS: Choice[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max', hint: 'Thinks longest' },
];

/** What each CLI is called, for "Default: <its own>". */
export const CLI_NAME: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
};

/** The agent as the model chip names it. */
export const AGENT_NAME: Record<AgentId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
};

/** Claude Code (`--effort`) and Codex (`model_reasoning_effort`) take an
 *  effort level; Gemini CLI doesn't. */
export const takesEffort = (agent: AgentId): boolean =>
  agent === 'claude' || agent === 'codex';

/** Claude picks from its aliases; the others take a model name as typed. */
export const hasModelAliases = (agent: AgentId): boolean => agent === 'claude';

export const modelKey = (agent: AgentId) => `agents.${agent}.model`;
export const effortKey = (agent: AgentId) => `agents.${agent}.effort`;

function text(store: Store, key: string): string | null {
  const v = store.models.settings.get(`user:${key}`)?.value;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function agentModel(store: Store, agent: AgentId): string | null {
  return text(store, modelKey(agent));
}

export function agentEffort(store: Store, agent: AgentId): string | null {
  if (!takesEffort(agent)) return null;
  const e = text(store, effortKey(agent));
  // Codex's levels come from its model catalog (`agent_models`), so any
  // name it gave is fine; Claude's are the fixed `--effort` set.
  if (agent === 'codex') return e;
  // `ultracode`: Claude's multi-agent mode, past Max (spaces).
  return e && (e === 'ultracode' || EFFORTS.some((x) => x.id === e)) ? e : null;
}

export function setAgentModel(
  store: RootStore,
  agent: AgentId,
  model: string | null,
): void {
  setSetting(store, 'user', modelKey(agent), model?.trim() || null);
}

export function setAgentEffort(
  store: RootStore,
  agent: AgentId,
  effort: string | null,
): void {
  setSetting(store, 'user', effortKey(agent), effort);
}

export function modelLabel(agent: AgentId, model: string | null): string {
  if (!model) return 'default model';
  if (!hasModelAliases(agent)) return model;
  return CLAUDE_MODELS.find((m) => m.id === model)?.label ?? model;
}

export function effortLabel(effort: string): string {
  if (effort === 'ultra') return 'Ultra';
  if (effort === 'ultracode') return 'Ultracode';
  return (
    EFFORTS.find((e) => e.id === effort)?.label ??
    effort.charAt(0).toUpperCase() + effort.slice(1)
  );
}

/** The chip text: `claude · Opus · High`, `codex · default model`. */
export function agentLabel(
  agent: AgentId,
  model: string | null,
  effort: string | null,
): string {
  const parts = [agent, modelLabel(agent, model)];
  if (effort && takesEffort(agent)) parts.push(effortLabel(effort));
  return parts.join(' · ');
}

/** `agentLabel` with the agent's current settings. */
export function agentLabelOf(store: Store, agent: AgentId): string {
  return agentLabel(agent, agentModel(store, agent), agentEffort(store, agent));
}

/** ⌘⇧/: the next of `levels` after `effort`, round to the first. */
export function nextEffort(
  effort: string | null,
  levels: string[] = EFFORTS.map((e) => e.id),
): string | null {
  if (!levels.length) return null;
  const i = effort ? levels.indexOf(effort) : -1;
  return levels[(i + 1) % levels.length]!;
}
