/**
 * The model picker sheet (docs/mobile.md "New space"): the host's agents,
 * each model a row, the effort the chosen model takes, Reset. What it
 * shows and what a tap picks, with no React Native, for every platform's
 * sheet (iOS formSheet route, Android Material 3 bottom sheet, web modal).
 *
 * ```text
 * Model                              CLAUDE                 (a heading per agent, 2+ listed)
 *   Opus 4.1        Default    ✓      a row per model; "Default" or the agent
 *   Sonnet 4.5      Claude
 * Effort   ( Default (High) ✓ )      what runs with no effort picked
 *   [Low|Med|High|XHigh|Max|Ultra]   the chosen model's levels
 * Reset to defaults                  nothing picked: the host's (a space: its own)
 *
 * tap a model ─▶ chooseModel() ─▶ applied at once; the sheet closes only
 *                when the new model takes no effort
 * ```
 */
import type { FleetAgentView } from '../fleet/types';
import {
  NO_PICK,
  effortLabel,
  listedModel,
  pickAgent,
  pickModel,
  running,
  type Pick,
} from './agents';

export interface ModelRow {
  /** Unique in the sheet: `<agent>/<model>`. */
  key: string;
  agent: string;
  /** `null`: an agent that lists no models (its CLI's own runs). */
  model: string | null;
  label: string;
  /** "Default" for the agent's default model, else the agent's name. */
  subtitle: string;
  selected: boolean;
  /** "Opus 4.1, Claude, default". */
  accessibilityLabel: string;
}

export interface ModelSection {
  agent: string;
  /** The agent's name when the host lists several; `null`: no heading. */
  title: string | null;
  rows: ModelRow[];
}

/** The agent's default model as listed (else its first). */
function defaultModelId(agent: FleetAgentView): string | null {
  return (
    listedModel(agent.models, agent.defaultModel)?.id ??
    agent.models[0]?.id ??
    null
  );
}

/** Every agent the host lists, its models as rows, ✓ on what runs. */
export function modelSections(
  agents: readonly FleetAgentView[],
  pick: Pick,
  current: Pick = NO_PICK,
): ModelSection[] {
  const now = running(agents, pick, current);
  const several = agents.length > 1;
  return agents.map((a) => {
    const def = defaultModelId(a);
    const here = now?.agent.id === a.id;
    const rows: ModelRow[] =
      a.models.length > 0
        ? a.models.map((m) => {
            const isDefault = m.id === def;
            return {
              key: `${a.id}/${m.id}`,
              agent: a.id,
              model: m.id,
              label: m.label,
              subtitle: isDefault ? 'Default' : a.label,
              selected: here && now?.modelId === m.id,
              accessibilityLabel: [
                m.label,
                a.label,
                ...(isDefault ? ['default'] : []),
              ].join(', '),
            };
          })
        : [
            {
              key: `${a.id}/`,
              agent: a.id,
              model: null,
              label: a.label,
              subtitle: 'Its default model',
              selected: here,
              accessibilityLabel: `${a.label}, its default model`,
            },
          ];
    return { agent: a.id, title: several ? a.label : null, rows };
  });
}

/**
 * The pick after tapping `model` of `agent`. The agent shown: the model
 * changes, an effort it takes stays. Another agent: it and the model are
 * named, the effort starts from its defaults (as picking an agent does).
 */
export function chooseModel(
  agents: readonly FleetAgentView[],
  pick: Pick,
  current: Pick,
  agent: string,
  model: string | null,
): Pick {
  const now = running(agents, pick, current);
  if (!agents.some((a) => a.id === agent)) return pick;
  if (now?.agent.id === agent) {
    return model === null ? pick : pickModel(agents, pick, current, model);
  }
  return model === null ? pickAgent(agent) : { agent, model, effort: null };
}

/** Short segment labels; the full one is read out. */
const EFFORT_SHORT: Record<string, string> = {
  medium: 'Med',
  xhigh: 'XHigh',
  ultracode: 'Ultra',
};

export interface EffortChoice {
  value: string;
  label: string;
  accessibilityLabel: string;
}

export interface EffortView {
  /** The chosen model's levels; empty: no effort to pick (no section). */
  choices: EffortChoice[];
  /** The level picked; `null`: the default runs. */
  value: string | null;
  /** "Default (High)": what runs with nothing picked. */
  defaultLabel: string;
}

export function effortView(
  agents: readonly FleetAgentView[],
  pick: Pick,
  current: Pick = NO_PICK,
): EffortView {
  const now = running(agents, pick, current);
  const levels = now?.levels ?? [];
  const def = running(agents, { ...pick, effort: null }, current)?.effort;
  const clash = levels.includes('ultra');
  return {
    choices: levels.map((e) => ({
      value: e,
      label:
        e === 'ultracode' && clash
          ? effortLabel(e)
          : (EFFORT_SHORT[e] ?? effortLabel(e)),
      accessibilityLabel: effortLabel(e),
    })),
    value: pick.effort && levels.includes(pick.effort) ? pick.effort : null,
    defaultLabel: def ? `Default (${effortLabel(def)})` : 'Default',
  };
}

/** After a model tap: close the sheet when there's no effort to choose. */
export function closesAfter(
  agents: readonly FleetAgentView[],
  pick: Pick,
  current: Pick = NO_PICK,
): boolean {
  return (running(agents, pick, current)?.levels.length ?? 0) === 0;
}

/** Anything picked (Reset has something to do). */
export const hasPick = (p: Pick): boolean => !!(p.agent || p.model || p.effort);

/**
 * Whether the chip is shown: the host lists agents and there is a choice
 * (another agent, a model, an effort).
 */
export function offersChoice(agents: readonly FleetAgentView[]): boolean {
  return (
    agents.length > 1 ||
    agents.some(
      (a) => a.models.length > 1 || a.models.some((m) => m.efforts.length > 0),
    )
  );
}
