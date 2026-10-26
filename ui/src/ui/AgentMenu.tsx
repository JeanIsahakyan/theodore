/**
 * The agent chip: which agent, and the model and effort it runs with, in
 * one menu (Agent / Model / Effort sections). The agent is the caller's
 * choice; model and effort are the agent's settings, shared everywhere.
 */
import { ChevronDown } from '@gravity-ui/icons';
import { Button, Dropdown, Header, Label } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { Selection } from 'react-aria-components';
import type { AgentId } from '../gen/contract';
import { useRootStore } from '../stores/context';
import {
  CLAUDE_MODELS,
  CLI_NAME,
  EFFORTS,
  agentEffort,
  agentLabelOf,
  agentModel,
  hasModelAliases,
  setAgentEffort,
  setAgentModel,
  takesEffort,
  type Choice,
} from './agentModel';

const DEFAULT = '__default';

/** The model choices for `agent`: Claude's aliases, or the name set in
 *  Settings → Agents for the others. */
function modelChoices(agent: AgentId, current: string | null): Choice[] {
  const own = {
    id: DEFAULT,
    label: 'Default',
    hint: `${CLI_NAME[agent]}'s own`,
  };
  if (hasModelAliases(agent)) {
    const extra =
      current && !CLAUDE_MODELS.some((m) => m.id === current)
        ? [{ id: current, label: current }]
        : [];
    return [own, ...CLAUDE_MODELS, ...extra];
  }
  return current ? [own, { id: current, label: current }] : [];
}

const first = (keys: Selection): string | null =>
  keys === 'all' ? null : ((keys.values().next().value as string) ?? null);

function Items({ prefix, items }: { prefix: string; items: Choice[] }) {
  return items.map((it) => (
    <Dropdown.Item key={it.id} id={`${prefix}${it.id}`} textValue={it.label}>
      <span className="flex flex-col">
        <Label>{it.label}</Label>
        {it.hint && <span className="text-xs text-muted">{it.hint}</span>}
      </span>
      <Dropdown.ItemIndicator />
    </Dropdown.Item>
  ));
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
  selected: AgentId[];
  onSelect: (next: AgentId[]) => void;
  /** Several agents at once (skills in the AI panel). */
  multiple?: boolean;
  isDisabled?: boolean;
}) {
  const store = useRootStore();
  const label = selected.map((a) => agentLabelOf(store, a)).join(' + ');
  const titled = selected.length > 1;
  return (
    <Dropdown>
      <Button
        size="sm"
        variant="tertiary"
        aria-label="Agent"
        isDisabled={isDisabled}
        className="min-w-0 shrink gap-1.5 rounded-full px-3 text-xs"
      >
        <span className="min-w-0 truncate">{label || 'agent'}</span>
        <ChevronDown className="size-3 shrink-0 text-muted" />
      </Button>
      <Dropdown.Popover placement="top start">
        <Dropdown.Menu aria-label="Agent, model and effort">
          <Dropdown.Section
            id="agent"
            selectionMode={multiple ? 'multiple' : 'single'}
            disallowEmptySelection
            selectedKeys={new Set(selected.map((a) => `agent:${a}`))}
            onSelectionChange={(keys) => {
              const ids =
                keys === 'all'
                  ? agents
                  : agents.filter((a) => keys.has(`agent:${a}`));
              if (ids.length) onSelect(ids);
            }}
          >
            <Header className="px-2 pt-1 text-xs text-muted">Agent</Header>
            <Items
              prefix="agent:"
              items={agents.map((a) => ({ id: a, label: a }))}
            />
          </Dropdown.Section>
          {selected.flatMap((a) => {
            const model = agentModel(store, a);
            const models = modelChoices(a, model);
            const effort = agentEffort(store, a);
            const sections = [];
            if (models.length) {
              sections.push(
                <Dropdown.Section
                  key={`model:${a}`}
                  id={`model:${a}`}
                  selectionMode="single"
                  disallowEmptySelection
                  selectedKeys={new Set([`model:${a}:${model ?? DEFAULT}`])}
                  onSelectionChange={(keys) => {
                    const k = first(keys)?.slice(`model:${a}:`.length);
                    if (k == null) return;
                    setAgentModel(store, a, k === DEFAULT ? null : k);
                  }}
                >
                  <Header className="px-2 pt-1 text-xs text-muted">
                    {titled ? `${a} model` : 'Model'}
                  </Header>
                  <Items prefix={`model:${a}:`} items={models} />
                </Dropdown.Section>,
              );
            }
            if (takesEffort(a)) {
              sections.push(
                <Dropdown.Section
                  key={`effort:${a}`}
                  id={`effort:${a}`}
                  selectionMode="single"
                  disallowEmptySelection
                  selectedKeys={new Set([`effort:${a}:${effort ?? DEFAULT}`])}
                  onSelectionChange={(keys) => {
                    const k = first(keys)?.slice(`effort:${a}:`.length);
                    if (k == null) return;
                    setAgentEffort(store, a, k === DEFAULT ? null : k);
                  }}
                >
                  <Header className="px-2 pt-1 text-xs text-muted">
                    {titled ? `${a} effort` : 'Effort'}
                  </Header>
                  <Items
                    prefix={`effort:${a}:`}
                    items={[
                      {
                        id: DEFAULT,
                        label: 'Default',
                        hint: `${CLI_NAME[a]}'s own`,
                      },
                      ...EFFORTS,
                    ]}
                  />
                </Dropdown.Section>,
              );
            }
            return sections;
          })}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
});
