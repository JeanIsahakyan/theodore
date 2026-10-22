import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRotateRight,
  ChevronRight,
  CircleCheckFill,
  CircleInfo,
  Cpu,
  Cubes3,
  Flask,
  Folder,
  Gear,
  Grip,
  Keyboard,
  Lock,
  LogoGithub,
  Person,
  PlugConnection,
} from '@gravity-ui/icons';
import {
  Button,
  Card,
  Chip,
  Input,
  InputGroup,
  Label,
  ListBox,
  Select,
  Separator,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { useDragAndDrop, type Key } from 'react-aria-components';
import type {
  AgentId,
  AgentStatus,
  AppInfo,
  HostAuthStatus,
  UpdateInfo,
} from '../gen/contract';
import { api, CommandFailure } from '../core/api';
import { useViewKeys } from './keys';
import { setSetting } from '../actions';
import { useDeviceLogin } from '../core/deviceLogin';
import { useRootStore, useUi, useWorkspaces } from '../stores/context';
import type { SettingsPage as Page } from '../stores/UiStore';
import { AgentTag, Avatar, Btn, K, Spinner } from './bits';
import { AccountCard } from './AccountCard';
import { DeviceLoginPanel } from './DeviceLoginPanel';
import { IntegrationsPage } from './linear/IntegrationsPage';
import { projectLabel } from './Projects';
import { SandboxBadge } from './sandbox/SandboxBadge';
import { SandboxPage } from './sandbox/SandboxPage';
import { visibleSettingsPages } from './sandbox/sandbox';
import { isLabsVisible } from './space/mode';
import { LabsPage } from './space/SpacePage';

const AGENTS: AgentId[] = ['claude', 'codex', 'gemini'];
const AI_KEYS = ['agents.grouping', 'agents.chat', 'agents.fix'] as const;
const AI_TITLE: Record<(typeof AI_KEYS)[number], string> = {
  'agents.grouping': 'Diff grouping',
  'agents.chat': 'Chat questions',
  'agents.fix': 'Finding fixes',
};
/** `PrSpend.budget_usd` — agent runs stop once a PR's spend reaches this. */
const BUDGET_KEY = 'budget.per_pr_usd';

/** Settings pages. */
const PAGES: { id: Page; title: string; icon: ReactNode }[] = [
  { id: 'account', title: 'Account', icon: <Person /> },
  { id: 'agents', title: 'Agents', icon: <Cpu /> },
  { id: 'integrations', title: 'Integrations', icon: <PlugConnection /> },
  { id: 'projects', title: 'Projects', icon: <Folder /> },
  { id: 'about', title: 'About & updates', icon: <CircleInfo /> },
  { id: 'sandbox', title: 'Sandbox', icon: <Cubes3 /> },
  { id: 'labs', title: 'Labs', icon: <Flask /> },
];

const SUB: Record<Page, string> = {
  account:
    'Your Theodore account and code host sign-ins. Tokens live in the system keychain.',
  agents: 'Agent CLIs on this computer, and which one handles each task.',
  integrations: 'Other tools Theodore can link PRs to.',
  projects: 'Connected repositories and the settings effective in each.',
  updates: 'Version, release channel and updates.',
  about: 'Version, release channel and updates.',
  sandbox: 'The simulated host this window runs against: faults and timeline.',
  labs: 'Hidden features in progress. They may change or go away.',
};

const SOURCE_LABEL: Record<HostAuthStatus['source'], string> = {
  keychain: 'a saved token',
  gh: 'your gh CLI login',
  env: 'GITHUB_TOKEN',
  none: 'nothing',
  sandbox: 'the sandbox (simulated host)',
};

/** The sidebar while in settings: the app's sections give way to the settings' own. */
export const SettingsNav = observer(function SettingsNav({
  page,
}: {
  page: Page;
}) {
  const store = useRootStore();
  const ui = useUi();
  // Esc leaves Settings, as the hint by "Back" says (inputs and dialogs keep
  // their own Esc: `useViewKeys` skips them).
  useViewKeys(
    ui,
    (e) => {
      if (e.key !== 'Escape') return false;
      ui.goBack();
    },
    [],
  );
  const labs = isLabsVisible(store);
  const pages = visibleSettingsPages(PAGES, store.ephemeral.sandbox).filter(
    (p) => p.id !== 'labs' || labs,
  );
  return (
    <aside className="sidebar settings-nav flex w-64 shrink-0 flex-col overflow-hidden border-r border-separator bg-background">
      <div data-tauri-drag-region className="px-3 pb-2 pt-11">
        <Button
          variant="ghost"
          size="sm"
          className="settings-back h-8 w-full justify-start gap-2 px-2 text-muted"
          onPress={() => ui.goBack()}
        >
          <ArrowLeft className="size-4" />
          Back
          <span className="flex-1" />
          <K>Esc</K>
        </Button>
        <div className="mt-3 flex items-center gap-2 px-2">
          <Typography.Heading level={6} className="flex-1">
            Settings
          </Typography.Heading>
          <SandboxBadge />
        </div>
      </div>
      <ListBox
        aria-label="Settings pages"
        selectionMode="single"
        selectedKeys={[page === 'updates' ? 'about' : page]}
        onSelectionChange={(keys) => {
          const k = keys === 'all' ? undefined : [...keys][0];
          if (k) ui.go({ name: 'settings', page: k as Page });
        }}
        className="min-h-0 flex-1 overflow-auto px-2 pb-3"
      >
        {pages.map((p) => (
          <ListBox.Item
            key={p.id}
            id={p.id}
            textValue={p.title}
            className="nav gap-3 px-3 text-sm data-[selected=true]:font-medium"
          >
            <span className="grid size-4 place-items-center text-muted [&>svg]:size-4">
              {p.icon}
            </span>
            {p.title}
          </ListBox.Item>
        ))}
      </ListBox>
    </aside>
  );
});

export function settingValue(
  store: ReturnType<typeof useRootStore>,
  scope: string,
  key: string,
): unknown {
  return store.models.settings.get(`${scope}:${key}`)?.value;
}

/** `agents.<id>.enabled`, `user` scope, default `true` (plan
 *  "enable/disable agents") — shared by the Settings Agents page and the
 *  chat/skill agent pickers in `SidePanel`. */
export function isAgentEnabled(
  store: ReturnType<typeof useRootStore>,
  agent: AgentId,
): boolean {
  const v = settingValue(store, 'user', `agents.${agent}.enabled`);
  return v !== false;
}

/** A host connected by a pasted token (GitLab, Bitbucket): no device-flow
 *  login, and not the primary host `host_status` reports on. */
const TokenHostSection = observer(function TokenHostSection({
  host,
  title,
  domain,
  hint,
  placeholder,
}: {
  host: 'gitlab' | 'bitbucket';
  title: string;
  domain: string;
  hint: string;
  placeholder: string;
}) {
  const [status, setStatus] = useState<HostAuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .hostStatusFor(host)
      .then((s) => live && setStatus(s))
      .catch(() => {
        // stays "Not connected"
      });
    return () => {
      live = false;
    };
  }, [host]);

  const setToken_ = (value: string | null) => {
    setError(null);
    setBusy(true);
    void api
      .setHostToken({ host, token: value })
      .then((s) => {
        setStatus(s);
        setEditing(false);
        setToken('');
      })
      .catch((e) =>
        setError(e instanceof CommandFailure ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <section className="flex flex-col gap-2">
      <Typography.Heading level={6}>{title}</Typography.Heading>
      <Card variant="secondary" className="gap-0 p-0">
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="size-7 shrink-0 rounded-full bg-default" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">
              {status?.login ?? 'Not connected'}{' '}
              <span className="text-muted">· {domain}</span>
            </span>
            <span className="text-xs text-muted">
              {status?.connected ? 'Signed in using a saved token' : hint}
            </span>
          </div>
        </div>
        <Separator />
        {editing ? (
          <div className="flex items-center gap-2 px-4 py-3">
            <TextField
              value={token}
              onChange={setToken}
              type="password"
              className="flex-1"
            >
              <Label className="sr-only">{title} token</Label>
              <Input
                autoFocus
                placeholder={placeholder}
                className="font-mono text-sm"
              />
            </TextField>
            <Button
              size="sm"
              isDisabled={token.trim().length < 4}
              onPress={() => setToken_(token.trim())}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onPress={() => {
                setEditing(false);
                setToken('');
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 p-1">
            <Button
              variant="ghost"
              className="m-1 justify-start gap-2"
              onPress={() => setEditing(true)}
            >
              <Lock className="size-4" />{' '}
              {status?.connected ? 'Replace token' : `Connect ${title}`}
            </Button>
            {status?.connected && (
              <Button
                variant="ghost"
                className="m-1 justify-start gap-2 text-danger"
                isDisabled={busy}
                onPress={() => setToken_(null)}
              >
                Remove
              </Button>
            )}
          </div>
        )}
      </Card>
      {error && <span className="text-xs text-danger">{error}</span>}
    </section>
  );
});

const AccountPage = observer(function AccountPage() {
  const store = useRootStore();
  const viewer = store.ephemeral.viewer;
  const [status, setStatus] = useState<HostAuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setBusy(true);
    void api
      .hostStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setBusy(false));
  };
  useEffect(load, []);

  const deviceLogin = useDeviceLogin(setStatus);

  const setToken_ = (value: string | null) => {
    setError(null);
    setBusy(true);
    void api
      .setHostToken({ host: 'github', token: value })
      .then((s) => {
        setStatus(s);
        setEditing(false);
        setToken('');
      })
      .catch((e) =>
        setError(e instanceof CommandFailure ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <>
      <AccountCard />
      <section className="flex flex-col gap-2">
        <Typography.Heading level={6}>GitHub</Typography.Heading>
        <Card variant="secondary" className="gap-0 p-0">
          <div className="flex items-center gap-3 px-4 py-3">
            {viewer ? (
              <Avatar person={viewer} size={28} />
            ) : (
              <span className="size-7 shrink-0 rounded-full bg-default" />
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">
                {status?.login ?? viewer?.login ?? 'Not connected'}{' '}
                <span className="text-muted">· github.com</span>
              </span>
              <span className="text-xs text-muted">
                {status?.connected
                  ? `Signed in using ${SOURCE_LABEL[status.source]}`
                  : 'Not connected'}
              </span>
            </div>
            {status?.connected && (
              <Chip size="sm" variant="soft" color="success" className="gap-1">
                <CircleCheckFill className="size-3" /> primary
              </Chip>
            )}
          </div>
          <Separator />
          {editing ? (
            <div className="flex items-center gap-2 px-4 py-3">
              <TextField
                value={token}
                onChange={setToken}
                type="password"
                className="flex-1"
              >
                <Label className="sr-only">Personal access token</Label>
                <Input
                  autoFocus
                  placeholder="ghp_…"
                  className="font-mono text-sm"
                />
              </TextField>
              <Button
                size="sm"
                isDisabled={token.trim().length < 8}
                onPress={() => setToken_(token.trim())}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onPress={() => {
                  setEditing(false);
                  setToken('');
                }}
              >
                Cancel
              </Button>
            </div>
          ) : deviceLogin.phase !== 'idle' ? (
            <div className="px-4 py-3">
              <DeviceLoginPanel state={deviceLogin} />
            </div>
          ) : (
            <div className="flex items-center gap-2 p-1">
              <Button
                variant="ghost"
                className="add-token m-1 justify-start gap-2"
                onPress={() => setEditing(true)}
              >
                <Lock className="size-4" />{' '}
                {status?.connected ? 'Replace token' : 'Sign in with a token'}
              </Button>
              {deviceLogin.available && !status?.connected && (
                <Button
                  variant="ghost"
                  className="gh-device-login m-1 justify-start gap-2"
                  onPress={deviceLogin.start}
                >
                  <LogoGithub className="size-4" /> Sign in with GitHub
                </Button>
              )}
              <Button
                variant="ghost"
                className="m-1 justify-start gap-2"
                isDisabled={busy}
                onPress={load}
              >
                Check again
              </Button>
              {status?.connected && (
                <Button
                  variant="ghost"
                  className="m-1 justify-start gap-2 text-danger"
                  isDisabled={busy}
                  onPress={() => setToken_(null)}
                >
                  Remove
                </Button>
              )}
            </div>
          )}
        </Card>
        {error && <span className="text-xs text-danger">{error}</span>}
      </section>
      <TokenHostSection
        host="gitlab"
        title="GitLab"
        domain="gitlab.com"
        hint="A personal access token with the api scope"
        placeholder="glpat-…"
      />
      <TokenHostSection
        host="bitbucket"
        title="Bitbucket"
        domain="bitbucket.org"
        hint="An app password (username:app_password) or an access token"
        placeholder="username:app_password"
      />
    </>
  );
});

const AgentsPage = observer(function AgentsPage() {
  const store = useRootStore();
  const [detected, setDetected] = useState<AgentStatus[] | null>(null);
  useEffect(() => {
    void api
      .detectAgents()
      .then(setDetected)
      .catch(() => setDetected([]));
  }, []);
  return (
    <>
      <section className="flex flex-col gap-2">
        <Typography.Heading level={6}>
          Agents on this computer
        </Typography.Heading>
        {!detected ? (
          <Spinner />
        ) : (
          <Card variant="secondary" className="agents gap-0 p-0">
            {detected.map((a) => {
              const enabled = isAgentEnabled(store, a.id);
              return (
                <div
                  key={a.id}
                  className="flex items-center gap-3 border-b border-separator px-4 py-2.5 last:border-b-0"
                >
                  <Switch
                    size="sm"
                    aria-label={`${a.id} enabled`}
                    // A missing CLI can't run, whatever its setting says.
                    isSelected={a.installed && enabled}
                    isDisabled={!a.installed}
                    onChange={(v) =>
                      setSetting(store, 'user', `agents.${a.id}.enabled`, v)
                    }
                  >
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch.Content>
                  </Switch>
                  <div
                    className={`flex items-center gap-1.5 ${enabled ? '' : 'opacity-50'}`}
                  >
                    <AgentTag id={a.id} />
                  </div>
                  <span
                    className={`min-w-0 flex-1 truncate font-mono text-xs text-muted ${enabled ? '' : 'opacity-50'}`}
                  >
                    {a.path ?? '—'}
                  </span>
                  <span className="text-xs text-muted">
                    {a.installed ? (a.version ?? 'installed') : 'not found'}
                  </span>
                </div>
              );
            })}
          </Card>
        )}
        <span className="text-xs text-muted">
          Disabled agents are hidden from the chat picker and skipped for
          grouping, skills and fixes. Agents use their own sign-in (
          <code className="font-mono">claude login</code>
          ); keys never reach this app.
        </span>
      </section>
      <Separator />
      <section className="flex flex-col gap-2">
        <Typography.Heading level={6}>Which agent does what</Typography.Heading>
        <Card variant="secondary" className="gap-0 p-0">
          {AI_KEYS.map((key) => {
            const value =
              (settingValue(store, 'user', key) as AgentId | undefined) ??
              'claude';
            return (
              <div
                key={key}
                className="set-row flex items-center gap-4 border-b border-separator px-4 py-3 last:border-b-0"
              >
                <span className="min-w-0 flex-1 text-sm font-medium">
                  {AI_TITLE[key]}
                </span>
                <ToggleButtonGroup
                  size="sm"
                  selectionMode="single"
                  disallowEmptySelection
                  aria-label={AI_TITLE[key]}
                  selectedKeys={new Set([value])}
                  onSelectionChange={(keys) => {
                    const v = [...keys][0];
                    if (v) setSetting(store, 'user', key, String(v));
                  }}
                >
                  {AGENTS.map((a, i) => (
                    <ToggleButton
                      key={a}
                      id={a}
                      className="whitespace-nowrap"
                      // Only agents installed on this computer can be picked.
                      isDisabled={
                        detected !== null &&
                        !detected.some((d) => d.id === a && d.installed)
                      }
                    >
                      {i > 0 && <ToggleButtonGroup.Separator />}
                      {a}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
              </div>
            );
          })}
        </Card>
      </section>
      <Separator />
      <section className="flex flex-col gap-2">
        <Typography.Heading level={6}>Budget</Typography.Heading>
        <Card variant="secondary" className="gap-0 p-0">
          <BudgetRow />
        </Card>
      </section>
    </>
  );
});

/** `budget.per_pr_usd`, user scope — effective per-repo value shown read-only
 *  in Settings → Projects → ⟨repo⟩. Empty clears the setting (no limit). */
const BudgetRow = observer(function BudgetRow() {
  const store = useRootStore();
  const raw = settingValue(store, 'user', BUDGET_KEY);
  const [text, setText] = useState(typeof raw === 'number' ? String(raw) : '');
  useEffect(() => {
    setText(typeof raw === 'number' ? String(raw) : '');
  }, [raw]);
  const commit = () => {
    const t = text.trim();
    if (!t) {
      setSetting(store, 'user', BUDGET_KEY, null);
      return;
    }
    const n = Number(t);
    if (Number.isFinite(n) && n > 0) setSetting(store, 'user', BUDGET_KEY, n);
  };
  return (
    <div className="set-row budget-per-pr flex items-center gap-4 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">Budget per PR (USD)</span>
        <span className="text-xs text-muted">
          Agent runs stop once a PR's spend reaches this. Empty = no limit.
        </span>
      </div>
      <TextField
        value={text}
        onChange={setText}
        aria-label="Budget per PR (USD)"
        className="w-32 shrink-0"
      >
        <InputGroup className="w-full rounded-xl">
          <InputGroup.Prefix className="text-xs text-muted">
            $
          </InputGroup.Prefix>
          <InputGroup.Input
            placeholder="No limit"
            inputMode="decimal"
            className="w-full min-w-0 text-right text-sm"
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
          />
        </InputGroup>
      </TextField>
    </div>
  );
});

const UpdatesPage = observer(function UpdatesPage() {
  const store = useRootStore();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  // What the last "Check now" found: nothing yet, up to date, or why it failed.
  const [result, setResult] = useState<
    { kind: 'latest'; at: number } | { kind: 'error'; message: string } | null
  >(null);
  const channel =
    (settingValue(store, 'user', 'updates.channel') as string) ?? 'stable';
  const check = () => {
    setChecking(true);
    void api
      .checkUpdate()
      .then((u) => {
        setUpdate(u);
        setResult(u ? null : { kind: 'latest', at: Date.now() });
      })
      .catch((e) => {
        setUpdate(null);
        setResult({
          kind: 'error',
          message: e instanceof CommandFailure ? e.message : String(e),
        });
      })
      .finally(() => setChecking(false));
  };
  return (
    <>
      <section className="flex flex-col gap-2">
        <Typography.Heading level={6}>Channel</Typography.Heading>
        <Card
          variant="secondary"
          className="flex-row items-center gap-4 px-4 py-3"
        >
          <span className="flex-1 text-sm text-muted">
            Which build to update to
          </span>
          <Select
            aria-label="Update channel"
            value={channel}
            onChange={(v) =>
              v && setSetting(store, 'user', 'updates.channel', v)
            }
            className="w-40"
          >
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox selectionMode="single">
                <ListBox.Item id="stable" textValue="Stable">
                  Stable
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item id="beta" textValue="Beta">
                  Beta
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        </Card>
      </section>
      <section className="flex flex-col gap-2">
        <Typography.Heading level={6}>Check for updates</Typography.Heading>
        <Btn
          tone="tertiary"
          className="self-start"
          isPending={checking}
          onPress={check}
        >
          Check now
        </Btn>
        {result?.kind === 'latest' && (
          <span className="text-xs text-muted">
            You're on the latest version.
          </span>
        )}
        {result?.kind === 'error' && (
          <span className="text-xs text-danger">{result.message}</span>
        )}
        {update && (
          <Card variant="secondary" className="flex flex-col gap-2 p-4 text-sm">
            <span className="font-medium">
              v{update.version}{' '}
              {update.downloaded ? '— ready to install' : '— downloading'}
            </span>
            <p className="text-muted">{update.notes}</p>
            {update.downloaded && (
              <Btn tone="primary" onPress={() => void api.installUpdate()}>
                Restart to update
              </Btn>
            )}
          </Card>
        )}
      </section>
    </>
  );
});

/** What `key` resolves to for `scope`, and where that value came from. */
function effectiveOf(
  store: ReturnType<typeof useRootStore>,
  scope: string,
  key: string,
): { value: unknown; source: 'repo' | 'user' | 'default' } {
  const repoVal = settingValue(store, scope, key);
  if (repoVal !== undefined) return { value: repoVal, source: 'repo' };
  const userVal = settingValue(store, 'user', key);
  if (userVal !== undefined) return { value: userVal, source: 'user' };
  return { value: undefined, source: 'default' };
}

const SOURCE_NOTE: Record<'repo' | 'user' | 'default', string> = {
  repo: 'from .review/config.yaml in this repo',
  user: 'from your user settings',
  default: 'default',
};

/** Settings → Projects → ⟨repo⟩: the settings effective for this repo and
 *  where each came from. Repo values are read-only here — they live in the
 *  repo's own `.review/config.yaml` and change by editing that file, not
 *  through this app. */
const RepoSettingsPage = observer(function RepoSettingsPage({
  project,
  onBack,
}: {
  project: { id: string; repo: { owner: string; name: string } };
  onBack: () => void;
}) {
  const store = useRootStore();
  const scope = `repo:${project.repo.owner}/${project.repo.name}`;
  const rows: { key: string; title: string }[] = [
    ...AI_KEYS.map((key) => ({ key, title: AI_TITLE[key] })),
    { key: BUDGET_KEY, title: 'Budget per PR (USD)' },
  ];
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="repo-settings-back w-fit gap-2 px-2 text-muted"
        onPress={onBack}
      >
        <ArrowLeft className="size-4" />
        Projects
      </Button>
      <section className="flex flex-col gap-2">
        <Typography.Heading level={6}>Effective settings</Typography.Heading>
        <Card variant="secondary" className="gap-0 p-0">
          {rows.map((r) => {
            const eff = effectiveOf(store, scope, r.key);
            return (
              <div
                key={r.key}
                className="set-row flex items-center gap-4 border-b border-separator px-4 py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium">{r.title}</span>
                  <span className="text-xs text-muted">
                    {SOURCE_NOTE[eff.source]}
                  </span>
                </div>
                <span className="text-sm tabular-nums text-muted">
                  {eff.value == null ? '—' : String(eff.value)}
                </span>
              </div>
            );
          })}
        </Card>
        <span className="text-xs text-muted">
          Repo values are read-only here — edit .review/config.yaml in the repo
          to change them.
        </span>
      </section>
    </>
  );
});

const ProjectsPage = observer(function ProjectsPage() {
  const store = useRootStore();
  const ws = useWorkspaces();
  const projects = ws.projects; // switcher order, not add order
  const [sel, setSel] = useState<string | null>(null);
  const project = sel ? store.models.projects.get(sel) : undefined;
  const { dragAndDropHooks } = useDragAndDrop({
    getItems: (keys) => [...keys].map((key) => ({ 'text/plain': String(key) })),
    onReorder(e) {
      const { dropPosition } = e.target;
      if (dropPosition !== 'before' && dropPosition !== 'after') return;
      ws.reorder([...e.keys].map(String), String(e.target.key), dropPosition);
    },
  });
  if (project) {
    return <RepoSettingsPage project={project} onBack={() => setSel(null)} />;
  }
  return (
    <section className="flex flex-col gap-2">
      <Typography.Heading level={6}>Connected repositories</Typography.Heading>
      {projects.length === 0 ? (
        <span className="text-sm text-muted">
          No projects yet — add one from the sidebar.
        </span>
      ) : (
        <>
          <Card variant="secondary" className="gap-0 p-0">
            <ListBox
              aria-label="Projects"
              selectionMode="none"
              dragAndDropHooks={dragAndDropHooks}
              onAction={(k: Key) => setSel(String(k))}
              className="p-0 [&>*+*]:mt-0"
            >
              {projects.map((p) => (
                <ListBox.Item
                  key={p.id}
                  id={p.id}
                  textValue={projectLabel(p)}
                  className="repo-row flex w-full items-center gap-3 rounded-none border-b border-separator px-4 py-3 last:border-b-0 hover:bg-default/50 data-[dragging]:opacity-50"
                >
                  <Grip
                    aria-hidden
                    className="size-4 shrink-0 cursor-grab text-muted"
                  />
                  <Folder className="size-4 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {projectLabel(p)}
                  </span>
                  <ChevronRight className="size-4 text-muted" />
                </ListBox.Item>
              ))}
            </ListBox>
          </Card>
          <span className="text-xs text-muted">
            Drag to reorder — the switcher and ⌃1…9 follow this order.
          </span>
        </>
      )}
    </section>
  );
});

const AboutPage = observer(function AboutPage() {
  const ui = useUi();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void api
      .appInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);
  if (!info) return <Spinner />;
  return (
    <section className="flex flex-col gap-2">
      <Card variant="secondary" className="flex flex-col gap-3 p-4 text-sm">
        <div className="flex items-center gap-2">
          <Gear className="size-4 text-muted" />
          <span className="font-medium">Theodore {info.version}</span>
        </div>
      </Card>
      <UpdatesPage />
      <Card
        variant="secondary"
        className="flex flex-row items-center gap-3 p-4"
      >
        <Keyboard className="size-4 text-muted" />
        <span className="flex-1 text-sm text-muted">
          Every shortcut, in one place.
        </span>
        <Button size="sm" variant="ghost" onPress={() => ui.openModal('help')}>
          Keyboard shortcuts
        </Button>
      </Card>
      <Card
        variant="secondary"
        className="flex flex-row items-center gap-3 p-4"
      >
        <ArrowRotateRight className="size-4 text-muted" />
        <span className="flex-1 text-sm text-muted">
          Show the welcome tour again the next time this view loads.
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="reset-onboarding"
          onPress={() => ui.resetOnboarding()}
        >
          Reset onboarding
        </Button>
      </Card>
    </section>
  );
});

export const SettingsPage = observer(function SettingsPage({
  page,
}: {
  page: Page;
}) {
  const store = useRootStore();
  const labs = isLabsVisible(store);
  // `updates` is an old page id: it now lives on About & updates.
  const shown: Page = page === 'updates' ? 'about' : page;
  const title = PAGES.find((p) => p.id === shown)?.title ?? 'Settings';
  return (
    <div className="view settings-page flex min-w-0 flex-1 flex-col overflow-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-8 py-8">
        <div>
          <Typography.Heading level={4}>{title}</Typography.Heading>
          <span className="text-sm text-muted">{SUB[page]}</span>
        </div>
        {page === 'account' ? (
          <AccountPage />
        ) : page === 'agents' ? (
          <AgentsPage />
        ) : page === 'integrations' ? (
          <IntegrationsPage />
        ) : page === 'projects' ? (
          <ProjectsPage />
        ) : page === 'sandbox' ? (
          <SandboxPage />
        ) : page === 'labs' ? (
          labs ? (
            <LabsPage />
          ) : null
        ) : (
          <AboutPage />
        )}
      </div>
    </div>
  );
});
