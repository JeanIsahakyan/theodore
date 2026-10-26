/**
 * The space composer: one rounded card holding the text and, under it, a
 * row of chips (agent, mode, base…) with the send / stop control on the
 * right. The same card starts a space (big, in the New space dialog) and
 * continues it (in the space's chat), so both read as one conversation.
 */
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
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
import type { AgentId, SkillInfo } from '../../gen/contract';
import { api } from '../../core/api';
import { useRootStore } from '../../stores/context';
import { AgentMenu } from '../AgentMenu';
import { isAgentEnabled } from '../Settings';
import { K } from '../bits';
import { SkillMenu, matchSkills, skillMenuKey } from '../SkillMenu';

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
  skills,
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
  /** Offered after `/` (and on the `/` button): picking one puts
   *  `/skill ` in the box, to send as is or with a task after it. */
  skills?: SkillInfo[];
}) {
  const empty = !value.trim();
  const own = useRef<HTMLTextAreaElement | null>(null);
  const matches = skills ? matchSkills(skills, value) : null;
  // The highlighted skill, back to the first whenever the text changes.
  const [hiAt, setHiAt] = useState({ text: '', i: 0 });
  const hi = hiAt.text === value ? hiAt.i : 0;
  const setHi = (f: (n: number) => number) =>
    setHiAt({ text: value, i: f(hi) });
  const pick = (s: SkillInfo) => {
    onChange(`/${s.id} `);
    own.current?.focus();
  };
  const ref = (el: HTMLTextAreaElement | null) => {
    own.current = el;
    assignRef(inputRef, el);
  };
  return (
    <div className="flex w-full flex-col gap-2">
      {matches && matches.length > 0 && (
        <SkillMenu
          matches={matches}
          hi={hi}
          onHover={(i) => setHi(() => i)}
          onPick={pick}
        />
      )}
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
            ref={ref}
            rows={rows}
            autoFocus={autoFocus}
            style={{ minHeight: `${rows * 1.625}em` }}
            className="w-full resize-none px-4 py-0 text-[15px] leading-relaxed"
            placeholder={placeholder}
            onKeyDown={(e) => {
              if (
                skillMenuKey(e, matches, hi, setHi, pick, () => onChange(''))
              ) {
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!empty && !running) onSubmit();
              } else if (e.key === 'Escape') {
                // In a dialog (New space) Esc closes the dialog. On the page
                // it leaves the box, so page keys work again.
                if (e.currentTarget.closest('[role="dialog"]')) return;
                e.stopPropagation();
                e.currentTarget.blur();
              }
            }}
          />
          <InputGroup.Suffix className="flex w-full items-center gap-1.5 px-2.5 py-0">
            {skills && (
              <Tooltip>
                <Button
                  isIconOnly
                  size="sm"
                  variant="tertiary"
                  aria-label="Skills"
                  className="slash-btn shrink-0 rounded-full font-mono"
                  isDisabled={disabled}
                  onPress={() => {
                    onChange(value === '/' ? '' : '/');
                    own.current?.focus();
                  }}
                >
                  /
                </Button>
                <Tooltip.Content>Skills</Tooltip.Content>
              </Tooltip>
            )}
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
    </div>
  );
}

/** Hands `el` to a caller's ref, object or callback. */
function assignRef<T>(ref: Ref<T> | undefined, el: T | null): void {
  if (typeof ref === 'function') ref(el);
  else if (ref) (ref as { current: T | null }).current = el;
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

/** The agent chip for a new space, with the agent's model and effort.
 *  `null` = the `agents.chat` default, shown as the first one offered. */
export const AgentChip = observer(function AgentChip({
  value,
  onChange,
  isDisabled,
}: {
  value: AgentId | null;
  onChange: (a: AgentId) => void;
  isDisabled?: boolean;
}) {
  const agents = useEnabledAgents();
  if (!agents.length) return null;
  const current = value && agents.includes(value) ? value : agents[0]!;
  return (
    <AgentMenu
      agents={agents}
      selected={[current]}
      onSelect={(next) => next[0] && onChange(next[0])}
      isDisabled={isDisabled}
    />
  );
});
