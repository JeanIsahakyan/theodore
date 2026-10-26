/**
 * The models each agent CLI can run, with the effort levels each takes
 * (`agent_models`): Claude's aliases, Codex's own catalog. Fetched once per
 * agent and kept for the session; empty while loading or when the CLI
 * can't say.
 */
import { useEffect, useState } from 'react';
import { api } from '../core/api';
import type { AgentId, AgentModel } from '../gen/contract';
import { CLAUDE_MODELS, EFFORTS } from './agentModel';

const cache = new Map<AgentId, Promise<AgentModel[]>>();

/** Claude's aliases, for when the core can't be asked. */
const CLAUDE_FALLBACK: AgentModel[] = CLAUDE_MODELS.map((m) => ({
  id: m.id,
  label: m.label,
  description: m.hint ?? null,
  efforts: EFFORTS.map((e) => e.id),
  default_effort: null,
}));

function load(agent: AgentId): Promise<AgentModel[]> {
  let p = cache.get(agent);
  if (!p) {
    p = Promise.resolve()
      .then(() => api.agentModels(agent))
      // The sandbox's fake agents list nothing: Claude's aliases still work.
      .then((list) =>
        !list.length && agent === 'claude' ? CLAUDE_FALLBACK : list,
      )
      .catch(() => {
        cache.delete(agent);
        return agent === 'claude' ? CLAUDE_FALLBACK : [];
      });
    cache.set(agent, p);
  }
  return p;
}

/** For tests: forget what was fetched. */
export function resetAgentModels(): void {
  cache.clear();
}

export function useAgentModels(
  agents: AgentId[],
): Partial<Record<AgentId, AgentModel[]>> {
  const [models, setModels] = useState<Partial<Record<AgentId, AgentModel[]>>>(
    {},
  );
  const key = agents.join(',');
  useEffect(() => {
    let live = true;
    for (const a of key ? (key.split(',') as AgentId[]) : []) {
      void load(a).then((list) => {
        if (live) setModels((m) => ({ ...m, [a]: list }));
      });
    }
    return () => {
      live = false;
    };
  }, [key]);
  return models;
}
