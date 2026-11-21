/**
 * The model picker sheet (docs/mobile.md "New space"): the host's agents,
 * each model a row, the effort the chosen model takes, Reset. What it
 * shows and what a tap picks, with no React Native, for every platform's
 * sheet (iOS formSheet route, Android Material 3 bottom sheet, web modal).
 *
 * ```text
 * main     Model                                topModels(): ≤ 4, ✓ on what runs
 *            Opus 4.1          Claude      ✓    (a picked one outside them: 5th)
 *            GPT-5             Codex
 *          All models                    12 ›   only when more are listed
 *          Effort            Default (High) ›   only when the model takes one
 * all      ‹ All models                         modelSections(): a heading per
 *            CLAUDE                               agent (2+ listed), "Default"
 *              Opus 4.1        Default     ✓
 *            Reset to defaults                  nothing picked: the host's
 * effort   ‹ Effort                             effortView()
 *            Default (High)                ✓
 *            Low · Medium · High · …
 *
 * tap a model ─▶ chooseModel() ─▶ applied; the sheet closes only when the
 *                new model takes no effort, else back to main
 * tap an effort ─▶ applied, back to main
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
  /** All models: "Default" for the agent's default model; top: the
   *  agent's name when the host lists several. */
  subtitle: string | null;
  /** The agent's default model (or its only row). */
  isDefault: boolean;
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
              subtitle: isDefault ? 'Default' : null,
              isDefault,
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
              isDefault: true,
              selected: here,
              accessibilityLabel: `${a.label}, its default model`,
            },
          ];
    return { agent: a.id, title: several ? a.label : null, rows };
  });
}

/** Models shown at the top of the sheet. */
export const TOP_MODELS = 4;

export interface ModelTop {
  rows: ModelRow[];
  /** Every model row the host lists ("All models  12"). */
  total: number;
  /** More are listed than shown: "All models" is offered. */
  more: boolean;
}

/**
 * The sheet's top: each agent's default model (agents in the host's
 * order), then their next models round-robin, up to TOP_MODELS; a picked
 * model outside them is added last, so ✓ always shows.
 */
export function topModels(
  agents: readonly FleetAgentView[],
  pick: Pick,
  current: Pick = NO_PICK,
): ModelTop {
  const sections = modelSections(agents, pick, current);
  const several = agents.length > 1;
  // Per agent: its default first, then the others as listed.
  const queues = sections.map((s) => {
    const def = s.rows.find((r) => r.isDefault);
    const rest = s.rows.filter((r) => r !== def);
    const label = agents.find((a) => a.id === s.agent)?.label ?? null;
    return (def ? [def, ...rest] : rest).map((r) => ({
      ...r,
      subtitle: several ? label : r.subtitle,
    }));
  });
  const all = queues.flat();
  const rows: ModelRow[] = [];
  for (let i = 0; rows.length < TOP_MODELS; i++) {
    const round = queues.map((q) => q[i]).filter((r) => !!r);
    if (round.length === 0) break;
    rows.push(...round.slice(0, TOP_MODELS - rows.length));
  }
  const chosen = all.find((r) => r.selected);
  if (chosen && !rows.some((r) => r.key === chosen.key)) rows.push(chosen);
  return { rows, total: all.length, more: all.length > rows.length };
}

/** All models offers a search field from this many models on. */
export const SEARCH_MIN_MODELS = 9;

/** `sections` cut to rows whose model or agent names `query`; empty
 *  sections dropped. A blank query keeps them all. */
export function filterSections(
  sections: readonly ModelSection[],
  agents: readonly FleetAgentView[],
  query: string,
): ModelSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...sections];
  return sections
    .map((s) => {
      const agent = agents.find((a) => a.id === s.agent)?.label ?? '';
      const hit = agent.toLowerCase().includes(q);
      return {
        ...s,
        rows: hit
          ? s.rows
          : s.rows.filter((r) => r.label.toLowerCase().includes(q)),
      };
    })
    .filter((s) => s.rows.length > 0);
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
  /** The Effort row's value: the level picked, else `defaultLabel`. */
  summary: string;
}

export function effortView(
  agents: readonly FleetAgentView[],
  pick: Pick,
  current: Pick = NO_PICK,
): EffortView {
  const now = running(agents, pick, current);
  const levels = now?.levels ?? [];
  const def = running(agents, { ...pick, effort: null }, current)?.effort;
  const value =
    pick.effort && levels.includes(pick.effort) ? pick.effort : null;
  const defaultLabel = def ? `Default (${effortLabel(def)})` : 'Default';
  return {
    choices: levels.map((e) => ({
      value: e,
      label: effortLabel(e),
      accessibilityLabel: effortLabel(e),
    })),
    value,
    defaultLabel,
    summary: value ? effortLabel(value) : defaultLabel,
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
