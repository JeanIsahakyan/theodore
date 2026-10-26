/**
 * The models each agent CLI can run, with the effort levels each takes
 * (`agent_models`): Claude's aliases, Codex's own catalog. Fetched once per
 * agent and kept for the session; empty while loading or when the CLI
 * can't say.
 */
import { useEffect, useState } from 'react';
import { api } from '../core/api';
import type { AgentId, AgentModel } from '../gen/contract';

const cache = new Map<AgentId, Promise<AgentModel[]>>();

function load(agent: AgentId): Promise<AgentModel[]> {
  let p = cache.get(agent);
  if (!p) {
    p = api.agentModels(agent).catch(() => {
      cache.delete(agent);
      return [];
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
