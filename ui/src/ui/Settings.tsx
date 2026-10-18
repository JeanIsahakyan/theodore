import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRotateRight,
  CircleCheckFill,
  CircleInfo,
  Cpu,
  Gear,
  Lock,
  LogoGithub,
} from '@gravity-ui/icons';
import {
  Alert,
  Button,
  Card,
  Chip,
  Input,
  Label,
  ListBox,
  Select,
  Separator,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type {
  AgentId,
  AgentStatus,
  AppInfo,
  HostAuthStatus,
  UpdateInfo,
} from '../gen/contract';
import { api, CommandFailure } from '../core/api';
import { setSetting } from '../actions';
import { FEATURES } from '../features';
import { useRootStore, useUi } from '../stores/context';
import type { SettingsPage as Page } from '../stores/UiStore';
import { AgentTag, Avatar, Btn, K, Spinner } from './bits';

const AGENTS: AgentId[] = ['claude', 'codex', 'gemini'];
const AI_KEYS = ['agents.grouping', 'agents.chat', 'agents.fix'] as const;
const AI_TITLE: Record<(typeof AI_KEYS)[number], string> = {
  'agents.grouping': 'Diff grouping',
  'agents.chat': 'Chat questions',
  'agents.fix': 'Finding fixes',
};

/** Settings pages. */
const PAGES: { id: Page; title: string; icon: ReactNode }[] = [
  { id: 'account', title: 'Account', icon: <LogoGithub /> },
  { id: 'agents', title: 'Agents', icon: <Cpu /> },
  { id: 'updates', title: 'Updates', icon: <ArrowRotateRight /> },
  { id: 'about', title: 'About', icon: <CircleInfo /> },
];

const SUB: Record<Page, string> = {
  account: 'GitHub sign-in. Tokens live in the system keychain.',
  agents: 'Agent CLIs on this computer, and which one handles each task.',
  updates: 'Check for and install new versions of Theodore.',
  about: 'Version and release channel.',
};

const SOURCE_LABEL: Record<HostAuthStatus['source'], string> = {
  keychain: 'a saved token',
  gh: 'your gh CLI login',
  env: 'GITHUB_TOKEN',
  none: 'nothing',
};

/** The sidebar while in settings: the app's sections give way to the settings' own. */
export const SettingsNav = observer(function SettingsNav({
  page,
}: {
  page: Page;
}) {
  const ui = useUi();
  return (
    <aside className="sidebar settings-nav flex w-64 shrink-0 flex-col overflow-hidden border-r border-separator bg-background">
      <div className="px-3 pb-2 pt-4">
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
        <Typography.Heading level={6} className="mt-3 px-2">
          Settings
        </Typography.Heading>
      </div>
      <ListBox
        aria-label="Settings pages"
        selectionMode="single"
        selectedKeys={[page]}
        onSelectionChange={(keys) => {
          const k = keys === 'all' ? undefined : [...keys][0];
          if (k) ui.go({ name: 'settings', page: k as Page });
        }}
        className="min-h-0 flex-1 overflow-auto px-2 pb-3"
      >
        {PAGES.map((p) => (
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

function settingValue(
  store: ReturnType<typeof useRootStore>,
  scope: string,
  key: string,
): unknown {
  return store.models.settings.get(`${scope}:${key}`)?.value;
}

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
      <section className="flex flex-col gap-2">
        <Typography.Heading level={6}>Linear</Typography.Heading>
        <Tooltip>
          <Card
            variant="secondary"
            className={`flex-row items-center gap-3 px-4 py-3 ${FEATURES.linear ? '' : 'opacity-60'}`}
          >
            <span className="flex-1 text-sm">Not connected</span>
            <Button size="sm" variant="ghost" isDisabled={!FEATURES.linear}>
              Connect
            </Button>
          </Card>
          {!FEATURES.linear && (
            <Tooltip.Content>Not available yet</Tooltip.Content>
          )}
        </Tooltip>
      </section>
      <section className="flex flex-col gap-2">
        <Typography.Heading level={6}>Devices</Typography.Heading>
        <Tooltip>
          <Card variant="secondary" className="gap-0 p-0 opacity-60">
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="flex-1 text-sm">
                This Mac <span className="text-muted">· now</span>
              </span>
              <Chip size="sm" variant="secondary">
                this device
              </Chip>
            </div>
          </Card>
          <Tooltip.Content>
            Device management not available yet
          </Tooltip.Content>
        </Tooltip>
      </section>
      <Tooltip>
        <Button variant="danger-soft" className="self-start" isDisabled>
          Sign out everywhere
        </Button>
        <Tooltip.Content>Not available yet</Tooltip.Content>
      </Tooltip>
    </>
  );
});

const AgentsPage = observer(function AgentsPage() {
  const store = useRootStore();
  const [detected, setDetected] = useState<AgentStatus[] | null>(null);
  useEffect(() => {
    void api.detectAgents().then(setDetected).catch(() => setDetected([]));
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
            {detected.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-3 border-b border-separator px-4 py-2.5 last:border-b-0"
              >
                <Tooltip>
                  <Switch
                    size="sm"
                    aria-label={`${a.id} on`}
                    isSelected={a.installed}
                    isDisabled
                  >
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch.Content>
                  </Switch>
                  <Tooltip.Content>Not available yet</Tooltip.Content>
                </Tooltip>
                <div className="flex items-center gap-1.5">
                  <AgentTag id={a.id} />
                </div>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
                  {a.path ?? '—'}
                </span>
                <span className="text-xs text-muted">
                  {a.installed ? (a.version ?? 'installed') : 'not found'}
                </span>
              </div>
            ))}
          </Card>
        )}
        <span className="text-xs text-muted">
          Who runs for what is set below. Agents use their own sign-in (
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
                    <ToggleButton key={a} id={a} className="whitespace-nowrap">
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
    </>
  );
});

const UpdatesPage = observer(function UpdatesPage() {
  const store = useRootStore();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const channel =
    (settingValue(store, 'user', 'updates.channel') as string) ?? 'stable';
  const check = () => {
    setChecking(true);
    void api
      .checkUpdate()
      .then(setUpdate)
      .catch(() => setUpdate(null))
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
        <Btn tone="tertiary" className="self-start" isPending={checking} onPress={check}>
          Check now
        </Btn>
        {update && (
          <Card
            variant="secondary"
            className="flex flex-col gap-2 p-4 text-sm"
          >
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

const AboutPage = observer(function AboutPage() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void api.appInfo().then(setInfo).catch(() => setInfo(null));
  }, []);
  if (!info) return <Spinner />;
  return (
    <section className="flex flex-col gap-2">
      <Card variant="secondary" className="flex flex-col gap-3 p-4 text-sm">
        <div className="flex items-center gap-2">
          <Gear className="size-4 text-muted" />
          <span className="font-medium">Theodore {info.version}</span>
        </div>
        <span className="text-muted">Channel: {info.channel}</span>
        {info.update && (
          <Alert status="default">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>
                Update available: v{info.update.version}
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        <Switch size="sm" isSelected aria-label="Automatic updates" isDisabled>
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            Check for updates automatically
          </Switch.Content>
        </Switch>
      </Card>
    </section>
  );
});

export const SettingsPage = observer(function SettingsPage({
  page,
}: {
  page: Page;
}) {
  const title = PAGES.find((p) => p.id === page)?.title ?? 'Settings';
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
        ) : page === 'updates' ? (
          <UpdatesPage />
        ) : (
          <AboutPage />
        )}
      </div>
    </div>
  );
});
