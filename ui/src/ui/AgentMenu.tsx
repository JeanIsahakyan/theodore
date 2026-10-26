/**
 * The model chip: one row per agent, its models in a submenu (Claude's
 * Opus / Sonnet / Haiku, Codex's own catalog), the effort the chosen model
 * takes in another, and ⌘⇧/ to cycle the effort from the box the chip sits
 * in. The agent is the caller's choice; model and effort are the agent's
 * settings, shared everywhere.
 */
import { useEffect, useMemo, useRef } from 'react';
import { ChevronDown, Gear } from '@gravity-ui/icons';
import { Button, Dropdown, Separator } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { AgentId, AgentModel } from '../gen/contract';
import { useRootStore, useUi } from '../stores/context';
import {
  AGENT_NAME,
  agentEffort,
  agentModel,
  effortLabel,
  nextEffort,
  setAgentEffort,
  setAgentModel,
  takesEffort,
} from './agentModel';
import { useAgentModels } from './useAgentModels';
import { K } from './bits';

/** The current model's name: its catalog label, else the id as set. */
function modelName(models: AgentModel[] | undefined, id: string | null) {
  if (!id) return null;
  return models?.find((m) => m.id === id)?.label ?? id;
}

/** The levels the current model takes: its own list, else the agent's
 *  first model's (Claude's are the same for every alias). */
function effortsOf(models: AgentModel[] | undefined, id: string | null) {
  const own = models?.find((m) => m.id === id);
  return own?.efforts ?? models?.[0]?.efforts ?? [];
}

export const AgentMenu = observer(function AgentMenu({
  agents,
  selected,
  onSelect,
  multiple,
  isDisabled,
}: {
  /** Offered: installed and enabled. */
  agents: AgentId[];
  /** The first runs chat turns; all of them run skills (`multiple`). */
  selected: AgentId[];
  onSelect: (next: AgentId[]) => void;
  /** Skills may run on several agents at once (the AI panel). */
  multiple?: boolean;
  isDisabled?: boolean;
}) {
  const store = useRootStore();
  const ui = useUi();
  const chip = useRef<HTMLSpanElement>(null);
  const catalog = useAgentModels(agents);
  const primary = selected[0] ?? agents[0] ?? null;
  const others = selected.slice(1);
  const model = primary ? agentModel(store, primary) : null;
  const effort = primary ? agentEffort(store, primary) : null;
  const levels = useMemo(
    () => (primary ? effortsOf(catalog[primary], model) : []),
    [catalog, primary, model],
  );
  const canEffort = !!primary && takesEffort(primary) && levels.length > 0;

  // ⌘⇧/ in the box this chip sits in: the next effort.
  useEffect(() => {
    if (!primary || !canEffort || isDisabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey && e.shiftKey && e.code === 'Slash')) return;
      const active = document.activeElement;
      if (!active || active === document.body) return;
      let scope = chip.current?.parentElement ?? null;
      for (let i = 0; scope && i < 4; i++, scope = scope.parentElement) {
        if (scope.contains(active)) {
          e.preventDefault();
          setAgentEffort(
            store,
            primary,
            nextEffort(agentEffort(store, primary), levels),
          );
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, primary, canEffort, isDisabled, levels]);

  const pick = (agent: AgentId, id: string) => {
    setAgentModel(store, agent, id);
    // A level the new model doesn't take falls back to its default.
    const e = agentEffort(store, agent);
    if (e && !effortsOf(catalog[agent], id).includes(e)) {
      setAgentEffort(store, agent, null);
    }
    if (agent !== primary) {
      onSelect([agent, ...others.filter((a) => a !== agent)]);
    }
  };

  const name = primary
    ? (modelName(catalog[primary], model) ?? AGENT_NAME[primary])
    : 'agent';
  const extra = others.map((a) => AGENT_NAME[a]).join(' + ');

  return (
    <span ref={chip} className="flex min-w-0 shrink">
      <Dropdown>
        <Button
          size="sm"
          variant="tertiary"
          aria-label="Model"
          isDisabled={isDisabled}
          className="min-w-0 shrink gap-1.5 rounded-full px-3 text-xs"
        >
          <span className="min-w-0 truncate">
            {name}
            {effort && canEffort && (
              <span className="text-muted"> {effortLabel(effort)}</span>
            )}
            {extra && <span className="text-muted"> + {extra}</span>}
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted" />
        </Button>
        <Dropdown.Popover placement="top start" className="min-w-60">
          <Dropdown.Menu
            aria-label="Model and effort"
            onAction={(key) => {
              if (String(key) === 'settings') {
                ui.go({ name: 'settings', page: 'agents' });
              }
            }}
          >
            {agents.map((a) => {
              const list = catalog[a] ?? [];
              const current = agentModel(store, a);
              const on = a === primary;
              return (
                <Dropdown.SubmenuTrigger key={a}>
                  <Dropdown.Item
                    id={`agent:${a}`}
                    textValue={AGENT_NAME[a]}
                    className="gap-2"
                  >
                    <span className={`flex-1 ${on ? 'font-medium' : ''}`}>
                      {AGENT_NAME[a]}
                    </span>
                    <span className="max-w-32 truncate text-xs text-muted">
                      {modelName(list, current) ?? ''}
                    </span>
                    <Dropdown.SubmenuIndicator />
                  </Dropdown.Item>
                  <Dropdown.Popover placement="right top" className="min-w-56">
                    <Dropdown.Menu
                      aria-label={`${AGENT_NAME[a]} models`}
                      selectionMode="single"
                      selectedKeys={
                        on && current ? new Set([current]) : new Set()
                      }
                      onAction={(k) => {
                        if (String(k) === 'settings') {
                          ui.go({ name: 'settings', page: 'agents' });
                        } else pick(a, String(k));
                      }}
                    >
                      {list.length
                        ? list.map((m) => (
                            <Dropdown.Item
                              key={m.id}
                              id={m.id}
                              textValue={m.label}
                            >
                              <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate">{m.label}</span>
                                {m.description && (
                                  <span className="truncate text-xs text-muted">
                                    {m.description}
                                  </span>
                                )}
                              </span>
                              <Dropdown.ItemIndicator />
                            </Dropdown.Item>
                          ))
                        : [
                            current ? (
                              <Dropdown.Item
                                key={current}
                                id={current}
                                textValue={current}
                              >
                                <span className="flex-1">{current}</span>
                                <Dropdown.ItemIndicator />
                              </Dropdown.Item>
                            ) : null,
                            <Dropdown.Item
                              key="settings"
                              id="settings"
                              textValue="Set a model in Settings"
                            >
                              <span className="flex-1 text-muted">
                                Set a model in Settings…
                              </span>
                            </Dropdown.Item>,
                          ].filter(Boolean)}
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown.SubmenuTrigger>
              );
            })}
            <Dropdown.Section id="tune">
              <Separator className="my-1" />
              {canEffort ? (
                <Dropdown.SubmenuTrigger>
                  <Dropdown.Item
                    id="effort"
                    textValue="Effort"
                    className="gap-2"
                  >
                    <span className="flex-1">Effort</span>
                    <span className="text-xs text-muted">
                      {effort ? effortLabel(effort) : 'Default'}
                    </span>
                    <Dropdown.SubmenuIndicator />
                  </Dropdown.Item>
                  <Dropdown.Popover placement="right top">
                    <Dropdown.Menu
                      aria-label="Effort"
                      selectionMode="single"
                      selectedKeys={effort ? new Set([effort]) : new Set()}
                      onAction={(k) =>
                        setAgentEffort(store, primary, String(k))
                      }
                    >
                      {levels.map((l) => (
                        <Dropdown.Item
                          key={l}
                          id={l}
                          textValue={effortLabel(l)}
                        >
                          <span className="flex-1">{effortLabel(l)}</span>
                          <Dropdown.ItemIndicator />
                        </Dropdown.Item>
                      ))}
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown.SubmenuTrigger>
              ) : null}
              {multiple && primary && agents.length > 1 ? (
                <Dropdown.SubmenuTrigger>
                  <Dropdown.Item
                    id="also"
                    textValue="Skills also run on"
                    className="gap-2"
                  >
                    <span className="flex-1">Skills also run on</span>
                    <span className="text-xs text-muted">
                      {others.length
                        ? others.map((a) => AGENT_NAME[a]).join(', ')
                        : 'None'}
                    </span>
                    <Dropdown.SubmenuIndicator />
                  </Dropdown.Item>
                  <Dropdown.Popover placement="right top">
                    <Dropdown.Menu
                      aria-label="Skills also run on"
                      selectionMode="multiple"
                      selectedKeys={new Set(others)}
                      onSelectionChange={(keys) => {
                        const also = agents.filter(
                          (a) =>
                            a !== primary && (keys === 'all' || keys.has(a)),
                        );
                        onSelect([primary, ...also]);
                      }}
                    >
                      {agents
                        .filter((a) => a !== primary)
                        .map((a) => (
                          <Dropdown.Item
                            key={a}
                            id={a}
                            textValue={AGENT_NAME[a]}
                          >
                            <span className="flex-1">{AGENT_NAME[a]}</span>
                            <Dropdown.ItemIndicator />
                          </Dropdown.Item>
                        ))}
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown.SubmenuTrigger>
              ) : null}
              <Dropdown.Item
                id="settings"
                textValue="Settings"
                className="gap-2"
              >
                <Gear className="size-3.5 text-muted" />
                <span className="flex-1 text-muted">Settings</span>
                {canEffort && (
                  <span className="flex items-center gap-1.5 text-xs text-muted">
                    <K>⌘⇧/</K> effort
                  </span>
                )}
              </Dropdown.Item>
            </Dropdown.Section>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </span>
  );
});
