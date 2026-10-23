/**
 * The space composer: one rounded card holding the text and, under it, a
 * row of chips (agent, mode, base…) with the send / stop control on the
 * right. The same card starts a space (big, in the New space dialog) and
 * continues it (in the space's chat), so both read as one conversation.
 */
import { useEffect, useState, type ReactNode, type Ref } from 'react';
import { ArrowUp, ChevronDown, Square } from '@gravity-ui/icons';
import {
  Button,
  Dropdown,
  InputGroup,
  Label,
  TextField,
  Tooltip,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { AgentId } from '../../gen/contract';
import { api } from '../../core/api';
import { useRootStore } from '../../stores/context';
import { isAgentEnabled } from '../Settings';
import { K } from '../bits';

export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  rows = 2,
  autoFocus,
  disabled,
  running,
  onStop,
  chips,
  submit,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
  rows?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  /** A turn is running: the arrow becomes Stop. */
  running?: boolean;
  onStop?: () => void;
  /** Left side of the footer row. */
  chips?: ReactNode;
  /** A labelled button instead of the round arrow (e.g. "Create"). */
  submit?: string;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const empty = !value.trim();
  return (
    <TextField
      fullWidth
      aria-label={placeholder}
      value={value}
      onChange={onChange}
      isDisabled={disabled}
    >
      {/* A quiet card: no focus ring around a box this big — the caret
          says where you are. */}
      <InputGroup
        fullWidth
        className="flex h-auto flex-col gap-2 rounded-3xl py-3 focus-within:border-separator focus-within:ring-0 data-[focus-within=true]:ring-0"
      >
        <InputGroup.TextArea
          ref={inputRef}
          rows={rows}
          autoFocus={autoFocus}
          style={{ minHeight: `${rows * 1.625}em` }}
          className="w-full resize-none px-4 py-0 text-[15px] leading-relaxed"
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!empty && !running) onSubmit();
            } else if (e.key === 'Escape') {
              // Leave the box, so page keys work again.
              e.stopPropagation();
              e.currentTarget.blur();
            }
          }}
        />
        <InputGroup.Suffix className="flex w-full items-center gap-1.5 px-2.5 py-0">
          {chips}
          <span className="flex-1" />
          {running ? (
            <Tooltip>
              <Button
                isIconOnly
                size="sm"
                variant="secondary"
                aria-label="Stop"
                className="shrink-0 rounded-full"
                onPress={onStop}
              >
                <Square className="size-3.5" />
              </Button>
              <Tooltip.Content>
                Stop <K>⌘.</K>
              </Tooltip.Content>
            </Tooltip>
          ) : submit ? (
            <Button
              size="sm"
              className="shrink-0 gap-2 rounded-full px-4"
              isDisabled={empty || disabled}
              onPress={onSubmit}
            >
              {submit}
              <span className="text-xs opacity-70">⏎</span>
            </Button>
          ) : (
            <Button
              isIconOnly
              size="sm"
              aria-label="Send"
              className="shrink-0 rounded-full"
              isDisabled={empty || disabled}
              onPress={onSubmit}
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
        </InputGroup.Suffix>
      </InputGroup>
    </TextField>
  );
}

/** A footer chip that opens a menu: label, chevron. */
export function ChipMenu<T extends string>({
  label,
  icon,
  ariaLabel,
  items,
  selected,
  onSelect,
  isDisabled,
}: {
  label: ReactNode;
  icon?: ReactNode;
  ariaLabel: string;
  items: { id: T; label: string; hint?: string }[];
  selected: T;
  onSelect: (id: T) => void;
  isDisabled?: boolean;
}) {
  return (
    <Dropdown>
      <Button
        size="sm"
        variant="tertiary"
        aria-label={ariaLabel}
        isDisabled={isDisabled}
        className="min-w-0 shrink gap-1.5 rounded-full px-3 text-xs"
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0 text-muted" />
      </Button>
      <Dropdown.Popover placement="top start">
        <Dropdown.Menu
          aria-label={ariaLabel}
          selectionMode="single"
          selectedKeys={new Set([selected])}
          onAction={(k) => onSelect(String(k) as T)}
        >
          {items.map((it) => (
            <Dropdown.Item key={it.id} id={it.id} textValue={it.label}>
              <span className="flex flex-col">
                <Label>{it.label}</Label>
                {it.hint && (
                  <span className="text-xs text-muted">{it.hint}</span>
                )}
              </span>
              <Dropdown.ItemIndicator />
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** Agent + model, as one choice: `claude`, `claude:opus`, `codex`… Only
 *  agents installed here and enabled in Settings → Agents. */
export type AgentChoice = string;

const CLAUDE_MODELS = [
  { model: 'opus', hint: 'Most capable' },
  { model: 'sonnet', hint: 'Balanced' },
  { model: 'haiku', hint: 'Fastest, cheapest' },
];

export function parseAgentChoice(c: AgentChoice): {
  agent: AgentId | null;
  model: string | null;
} {
  if (!c) return { agent: null, model: null };
  const [agent, model] = c.split(':');
  return { agent: agent as AgentId, model: model ?? null };
}

export function agentChoices(
  agents: AgentId[],
): { id: AgentChoice; label: string; hint?: string }[] {
  return agents.flatMap(
    (a): { id: AgentChoice; label: string; hint?: string }[] =>
      a === 'claude'
        ? [
            { id: 'claude', label: 'claude', hint: 'Default model' },
            ...CLAUDE_MODELS.map((m) => ({
              id: `claude:${m.model}`,
              label: `claude · ${m.model}`,
              hint: m.hint,
            })),
          ]
        : [{ id: a, label: a }],
  );
}

/** The agents offered for a new space: installed and enabled. */
export const useEnabledAgents = (): AgentId[] => {
  const store = useRootStore();
  const [agents, setAgents] = useState<AgentId[]>([]);
  useEffect(() => {
    let live = true;
    void api
      .detectAgents()
      .then((all) => {
        if (!live) return;
        setAgents(
          all
            .filter((a) => a.installed && isAgentEnabled(store, a.id))
            .map((a) => a.id),
        );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [store]);
  return agents;
};

/** The agent chip for a new space. Empty `value` = the `agents.chat`
 *  default, shown as "claude" (or whatever is first). */
export const AgentChip = observer(function AgentChip({
  value,
  onChange,
}: {
  value: AgentChoice;
  onChange: (c: AgentChoice) => void;
}) {
  const agents = useEnabledAgents();
  const items = agentChoices(agents);
  if (!items.length) return null;
  const current = value || items[0]!.id;
  const label = items.find((i) => i.id === current)?.label ?? current;
  return (
    <ChipMenu
      ariaLabel="Agent"
      label={label}
      items={items}
      selected={current}
      onSelect={onChange}
    />
  );
});
