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
  { id: 'opus', label: 'Opus', hint: 'Most capable' },
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

/** Only Claude Code takes an effort level (`--effort`). */
export const takesEffort = (agent: AgentId): boolean => agent === 'claude';

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
  return e && EFFORTS.some((x) => x.id === e) ? e : null;
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
  return EFFORTS.find((e) => e.id === effort)?.label ?? effort;
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
