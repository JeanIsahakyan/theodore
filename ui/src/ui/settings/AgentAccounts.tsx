/**
 * Settings → Agents → Accounts (docs/plan.md "Agent accounts and limits"):
 * each agent's accounts with their sign-in and usage limit, which one runs
 * first, extra accounts added and removed, and what a space does when every
 * account of its agent is limited.
 *
 * ```text
 * claude  default   ~/.claude          signed in   ok          preferred
 *         work      …/accounts/work    not signed  limited until 18:00
 *                   $ CLAUDE_CONFIG_DIR=… claude  [copy] Check again Remove
 *         + Add account
 * ```
 */
import { useEffect, useState } from 'react';
import { Check, Copy } from '@gravity-ui/icons';
import {
  Button,
  Card,
  Chip,
  Input,
  Label,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type {
  AgentAccountStatus,
  AgentId,
  AgentLimit,
} from '../../gen/contract';
import { api } from '../../core/api';
import { setSetting } from '../../actions';
import { useRootStore } from '../../stores/context';
import { AGENT_NAME } from '../agentModel';
import { isLimited, limitLabel } from '../agentLimit';
import { AgentTag, Spinner } from '../bits';

const AGENTS: AgentId[] = ['claude', 'codex', 'gemini'];
export const AUTO_CONTINUE_KEY = 'agents.auto_continue';
export const FALLBACK_AGENTS_KEY = 'agents.fallback_agents';
const preferredKey = (agent: AgentId) => `agents.${agent}.account`;

type Store = ReturnType<typeof useRootStore>;

function userSetting(store: Store, key: string): unknown {
  return store.models.settings.get(`user:${key}`)?.value;
}

/** `agents.<agent>.account`, default `default`; an account since removed
 *  reads as the default one. */
export function preferredAccount(
  store: Store,
  agent: AgentId,
  accounts: readonly AgentAccountStatus[],
): string {
  const v = userSetting(store, preferredKey(agent));
  const id = typeof v === 'string' ? v : 'default';
  return accounts.some((a) => a.account.agent === agent && a.account.id === id)
    ? id
    : 'default';
}

/** `agents.auto_continue`, default on. */
export function isAutoContinue(store: Store): boolean {
  return userSetting(store, AUTO_CONTINUE_KEY) !== false;
}

/** `agents.fallback_agents`, default none: known agents only, in order. */
export function fallbackAgents(store: Store): AgentId[] {
  const v = userSetting(store, FALLBACK_AGENTS_KEY);
  if (!Array.isArray(v)) return [];
  return v.filter(
    (a, i): a is AgentId => AGENTS.includes(a as AgentId) && v.indexOf(a) === i,
  );
}

/** The fallback list after the toggles became `selected`: those kept stay
 *  where they were, a new one goes last. */
export function nextFallbacks(
  current: readonly AgentId[],
  selected: ReadonlySet<AgentId>,
): AgentId[] {
  const kept = current.filter((a) => selected.has(a));
  const added = AGENTS.filter((a) => selected.has(a) && !kept.includes(a));
  return [...kept, ...added];
}

/** A clock for the limit chips: a limit that reset reads `ok` within a
 *  minute. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function signInLabel(s: AgentAccountStatus): string {
  if (s.signed_in === true) return 'signed in';
  if (s.signed_in === false) return 'not signed in';
  return 'sign-in unknown';
}

export const AgentAccounts = observer(function AgentAccounts() {
  const store = useRootStore();
  const [rows, setRows] = useState<AgentAccountStatus[] | null>(null);
  const now = useMinuteClock();
  useEffect(() => {
    let live = true;
    void api
      .agentAccounts()
      .then((list) => live && setRows(list))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, []);
  const put = (s: AgentAccountStatus) =>
    setRows((list) => {
      const same = (a: AgentAccountStatus) =>
        a.account.agent === s.account.agent && a.account.id === s.account.id;
      if (!list) return [s];
      return list.some(same)
        ? list.map((a) => (same(a) ? s : a))
        : [...list, s];
    });
  const drop = (agent: AgentId, id: string) =>
    setRows(
      (list) =>
        list?.filter(
          (a) => !(a.account.agent === agent && a.account.id === id),
        ) ?? null,
    );
  return (
    <section className="agent-accounts flex flex-col gap-2">
      <Typography.Heading level={6}>Accounts</Typography.Heading>
      {!rows ? (
        <Spinner />
      ) : (
        <Card variant="secondary" className="gap-0 p-0">
          {AGENTS.map((agent) => (
            <AgentGroup
              key={agent}
              agent={agent}
              accounts={rows.filter((r) => r.account.agent === agent)}
              preferred={preferredAccount(store, agent, rows)}
              now={now}
              onPut={put}
              onDrop={(id) => drop(agent, id)}
            />
          ))}
        </Card>
      )}
      <span className="text-xs text-muted">
        A run starts on the preferred account while it isn&apos;t limited, then
        on the agent&apos;s other accounts. An extra account keeps its own
        sign-in in its own folder: run its command in a terminal once.
      </span>
      <Card variant="secondary" className="gap-0 p-0">
        <AutoContinueRow />
        <FallbackAgentsRow />
      </Card>
    </section>
  );
});

const AgentGroup = observer(function AgentGroup({
  agent,
  accounts,
  preferred,
  now,
  onPut,
  onDrop,
}: {
  agent: AgentId;
  accounts: AgentAccountStatus[];
  preferred: string;
  now: number;
  onPut: (s: AgentAccountStatus) => void;
  onDrop: (id: string) => void;
}) {
  return (
    <div
      data-agent={agent}
      className="agent-accounts-group flex flex-col gap-2 border-b border-separator px-4 py-3 last:border-b-0"
    >
      <div className="flex items-center gap-2">
        <AgentTag id={agent} />
        <span className="flex-1" />
        <AddAccount agent={agent} onAdded={onPut} />
      </div>
      {accounts.map((s) => (
        <AccountRow
          key={s.account.id}
          status={s}
          preferred={s.account.id === preferred}
          now={now}
          onPut={onPut}
          onDrop={() => onDrop(s.account.id)}
        />
      ))}
      {agent === 'gemini' && (
        <span className="text-xs text-muted">
          Gemini CLI has no config-dir switch: an extra Gemini account is an API
          key. Its command writes the key to the account folder&apos;s{' '}
          <code className="font-mono">.env</code>.
        </span>
      )}
    </div>
  );
});

const AccountRow = observer(function AccountRow({
  status,
  preferred,
  now,
  onPut,
  onDrop,
}: {
  status: AgentAccountStatus;
  preferred: boolean;
  now: number;
  onPut: (s: AgentAccountStatus) => void;
  onDrop: () => void;
}) {
  const store = useRootStore();
  const { account } = status;
  const [busy, setBusy] = useState<'check' | 'remove' | null>(null);
  // The live row, so the chip moves as runs report; the command's
  // snapshot until one arrives.
  const limit: AgentLimit | null =
    store.models.agentLimits.of(account.agent, account.id)?.limit ??
    status.limit?.limit ??
    null;
  const label = limitLabel(limit, now);
  const req = { id: account.id, agent: account.agent };
  const check = () => {
    setBusy('check');
    void api
      .checkAgentAccount({ ...req, recheck: true })
      .then(onPut)
      .catch(() => {})
      .finally(() => setBusy(null));
  };
  const remove = () => {
    setBusy('remove');
    void api
      .removeAgentAccount(req)
      .then(onDrop)
      .catch(() => setBusy(null));
  };
  return (
    <div
      data-account={account.id}
      className="agent-account flex flex-col gap-1.5"
    >
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="account-label truncate text-sm font-medium">
            {account.default ? 'default' : account.label}
          </span>
          <span
            className="truncate font-mono text-xs text-muted"
            title={account.config_dir}
          >
            {account.config_dir}
          </span>
        </span>
        <span
          className={`account-sign-in text-xs ${status.signed_in === false ? 'text-warning' : 'text-muted'}`}
        >
          {signInLabel(status)}
        </span>
        {label && (
          <Chip
            size="sm"
            variant="soft"
            color={
              isLimited(limit, now)
                ? 'danger'
                : limit?.status === 'warning'
                  ? 'warning'
                  : 'success'
            }
            className="account-limit whitespace-nowrap"
          >
            {label}
          </Chip>
        )}
        {preferred ? (
          <Chip size="sm" variant="soft" color="accent" className="preferred">
            preferred
          </Chip>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="make-preferred h-6 px-2 text-xs"
            onPress={() =>
              setSetting(
                store,
                'user',
                `agents.${account.agent}.account`,
                account.id,
              )
            }
          >
            Make preferred
          </Button>
        )}
      </div>
      {!account.default && (
        <div className="flex flex-wrap items-center gap-2">
          {status.sign_in_command && (
            <span className="flex min-w-0 flex-1 items-center gap-1 rounded bg-default px-2 py-1">
              <code className="sign-in-command min-w-0 flex-1 truncate font-mono text-xs">
                {status.sign_in_command}
              </code>
              <CopyButton value={status.sign_in_command} />
            </span>
          )}
          <Button
            size="sm"
            variant="tertiary"
            className="account-check h-6 px-2 text-xs"
            isDisabled={busy != null}
            isPending={busy === 'check'}
            onPress={check}
          >
            Check again
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="account-remove h-6 px-2 text-xs text-danger"
            isDisabled={busy != null}
            isPending={busy === 'remove'}
            onPress={remove}
          >
            Remove
          </Button>
        </div>
      )}
    </div>
  );
});

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy command"
      title="Copy command"
      className="copy-command grid size-5 shrink-0 place-items-center rounded text-muted hover:bg-surface"
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function AddAccount({
  agent,
  onAdded,
}: {
  agent: AgentId;
  onAdded: (s: AgentAccountStatus) => void;
}) {
  const [label, setLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = () => {
    const l = label?.trim();
    if (!l) return;
    setBusy(true);
    void api
      .addAgentAccount({ agent, label: l })
      .then((s) => {
        onAdded(s);
        setLabel(null);
      })
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  if (label === null) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="add-account h-6 px-2 text-xs"
        onPress={() => setLabel('')}
      >
        Add account
      </Button>
    );
  }
  return (
    <span className="add-account-form flex items-center gap-1.5">
      <TextField value={label} onChange={setLabel} className="w-40">
        <Label className="sr-only">New {AGENT_NAME[agent]} account</Label>
        <Input
          autoFocus
          placeholder="Label (work, personal…)"
          className="text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
            else if (e.key === 'Escape') {
              e.stopPropagation();
              setLabel(null);
            }
          }}
        />
      </TextField>
      <Button
        size="sm"
        className="add-account-save h-7 px-2 text-xs"
        isDisabled={!label.trim()}
        isPending={busy}
        onPress={add}
      >
        Add
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        onPress={() => setLabel(null)}
      >
        Cancel
      </Button>
    </span>
  );
}

const AutoContinueRow = observer(function AutoContinueRow() {
  const store = useRootStore();
  const title = 'Continue automatically after a usage limit';
  return (
    <div className="set-row flex items-center gap-4 border-b border-separator px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted">
          A space cut off by its account&apos;s limit goes on with another
          account or a fallback agent, or waits for the reset and goes on then.
          Off: it stops and keeps its queue.
        </span>
      </div>
      <Switch
        size="sm"
        aria-label={title}
        isSelected={isAutoContinue(store)}
        onChange={(v) => setSetting(store, 'user', AUTO_CONTINUE_KEY, v)}
      >
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
    </div>
  );
});

const FallbackAgentsRow = observer(function FallbackAgentsRow() {
  const store = useRootStore();
  const current = fallbackAgents(store);
  return (
    <div className="set-row flex items-center gap-4 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">Fallback agents</span>
        <span className="text-xs text-muted">
          When every account of a space&apos;s agent is limited, it goes on with
          these, in the order picked. None: it waits for the reset.
        </span>
      </div>
      <ToggleButtonGroup
        size="sm"
        selectionMode="multiple"
        aria-label="Fallback agents"
        className="fallback-agents"
        selectedKeys={new Set(current)}
        onSelectionChange={(keys) =>
          setSetting(
            store,
            'user',
            FALLBACK_AGENTS_KEY,
            nextFallbacks(current, new Set([...keys].map(String) as AgentId[])),
          )
        }
      >
        {AGENTS.map((a, i) => {
          const at = current.indexOf(a);
          return (
            <ToggleButton key={a} id={a} className="whitespace-nowrap">
              {i > 0 && <ToggleButtonGroup.Separator />}
              {at >= 0 ? `${at + 1}. ${a}` : a}
            </ToggleButton>
          );
        })}
      </ToggleButtonGroup>
    </div>
  );
});
