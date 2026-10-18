import { useEffect, useState } from 'react';
import { ArrowLeft, Gear, Lock, LogoGithub, Sparkles } from '@gravity-ui/icons';
import {
  Alert,
  Button,
  Input,
  Label,
  ListBox,
  Select,
  Separator,
  Switch,
  TextField,
  Toolbar,
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
import { useRootStore, useUi } from '../stores/context';
import type { SettingsPage as Page } from '../stores/UiStore';
import { Btn, Spinner } from './bits';

const AGENTS: AgentId[] = ['claude', 'codex', 'gemini'];
const AI_KEYS = ['agents.grouping', 'agents.chat', 'agents.fix'] as const;
const AI_TITLE: Record<(typeof AI_KEYS)[number], string> = {
  'agents.grouping': 'Diff grouping',
  'agents.chat': 'Chat questions',
  'agents.fix': 'Finding fixes',
};

const PAGES: { id: Page; title: string }[] = [
  { id: 'account', title: 'Account' },
  { id: 'agents', title: 'Agents' },
  { id: 'updates', title: 'Updates' },
  { id: 'about', title: 'About' },
];

const SOURCE_LABEL: Record<HostAuthStatus['source'], string> = {
  keychain: 'a saved token',
  gh: 'your gh CLI login',
  env: 'GITHUB_TOKEN',
  none: 'nothing',
};

export const SettingsNav = observer(function SettingsNav({
  page,
}: {
  page: Page;
}) {
  const ui = useUi();
  return (
    <aside className="sidebar flex w-64 shrink-0 flex-col overflow-hidden border-r border-separator bg-background">
      <Toolbar
        aria-label="Settings"
        className="flex w-full items-center gap-2 px-5 pb-3 pt-4"
      >
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label="Back"
          onPress={() => ui.goBack()}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <span className="font-semibold">Settings</span>
      </Toolbar>
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
            className="gap-3 px-3 text-sm"
          >
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

  if (!status)
    return busy ? (
      <Spinner />
    ) : (
      <p className="text-sm text-muted">Not available.</p>
    );

  return (
    <div className="flex max-w-[640px] flex-col gap-6">
      <section className="flex flex-col gap-3">
        <Typography.Heading level={6}>GitHub</Typography.Heading>
        {status.connected ? (
          <Alert status="success">
            <Alert.Indicator>
              <LogoGithub className="size-4" />
            </Alert.Indicator>
            <Alert.Content>
              <Alert.Title>
                Signed in {status.login ? `as ${status.login}` : ''}
              </Alert.Title>
              <Alert.Description>
                Using {SOURCE_LABEL[status.source]}.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        ) : (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Not connected</Alert.Title>
            </Alert.Content>
          </Alert>
        )}
        {editing ? (
          <div className="flex flex-col gap-3">
            <TextField value={token} onChange={setToken} type="password">
              <Label>Personal access token</Label>
              <Input placeholder="ghp_…" className="font-mono" />
            </TextField>
            {error && <span className="text-xs text-danger">{error}</span>}
            <div className="flex gap-2">
              <Btn
                tone="primary"
                isDisabled={token.trim().length < 8}
                isPending={busy}
                onPress={() => setToken_(token.trim())}
              >
                Save
              </Btn>
              <Btn tone="ghost" onPress={() => setEditing(false)}>
                Cancel
              </Btn>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <Btn
              tone="tertiary"
              icon={<Lock />}
              onPress={() => setEditing(true)}
            >
              Replace token
            </Btn>
            <Btn tone="tertiary" onPress={load} isPending={busy}>
              Check again
            </Btn>
            {status.connected && (
              <Btn
                tone="danger-soft"
                isPending={busy}
                onPress={() => setToken_(null)}
              >
                Remove
              </Btn>
            )}
          </div>
        )}
      </section>
    </div>
  );
});

const AgentsPage = observer(function AgentsPage() {
  const store = useRootStore();
  const [detected, setDetected] = useState<AgentStatus[] | null>(null);
  useEffect(() => {
    void api.detectAgents().then(setDetected);
  }, []);
  return (
    <div className="flex max-w-[640px] flex-col gap-6">
      <section className="flex flex-col gap-3">
        <Typography.Heading level={6}>Installed agents</Typography.Heading>
        {!detected ? (
          <Spinner />
        ) : (
          <div className="flex flex-col gap-2">
            {detected.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-3 rounded-2xl border border-separator px-4 py-2.5 text-sm"
              >
                <Sparkles className="size-4 text-muted" />
                <span className="font-mono font-medium">{a.id}</span>
                <span className="flex-1" />
                {a.installed ? (
                  <span className="text-muted">{a.version ?? 'installed'}</span>
                ) : (
                  <span className="text-muted">not found</span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      <Separator />
      <section className="flex flex-col gap-3">
        <Typography.Heading level={6}>Which agent does what</Typography.Heading>
        {AI_KEYS.map((key) => {
          const value =
            (settingValue(store, 'user', key) as AgentId | undefined) ??
            'claude';
          return (
            <div key={key} className="flex items-center justify-between gap-4">
              <span className="text-sm text-muted">{AI_TITLE[key]}</span>
              <Select
                aria-label={AI_TITLE[key]}
                value={value}
                onChange={(v) => v && setSetting(store, 'user', key, v)}
                className="w-40"
              >
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox selectionMode="single">
                    {AGENTS.map((a) => (
                      <ListBox.Item key={a} id={a} textValue={a}>
                        {a}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>
          );
        })}
      </section>
    </div>
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
      .finally(() => setChecking(false));
  };
  return (
    <div className="flex max-w-[640px] flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm text-muted">Channel</span>
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
        </div>
        <Btn tone="tertiary" isPending={checking} onPress={check}>
          Check now
        </Btn>
        {update && (
          <div className="flex flex-col gap-2 rounded-2xl border border-separator p-4 text-sm">
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
          </div>
        )}
      </section>
    </div>
  );
});

const AboutPage = observer(function AboutPage() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void api.appInfo().then(setInfo);
  }, []);
  if (!info) return <Spinner />;
  return (
    <div className="flex max-w-[640px] flex-col gap-3 text-sm">
      <div className="flex items-center gap-2">
        <Gear className="size-4 text-muted" />
        <span className="font-medium">Theodore {info.version}</span>
      </div>
      <span className="text-muted">Channel: {info.channel}</span>
      {info.update && (
        <span className="text-accent">
          Update available: v{info.update.version}
        </span>
      )}
      <Switch size="sm" isSelected aria-label="Automatic updates" isDisabled>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          Check for updates automatically
        </Switch.Content>
      </Switch>
    </div>
  );
});

export const SettingsPage = observer(function SettingsPage({
  page,
}: {
  page: Page;
}) {
  const title = PAGES.find((p) => p.id === page)?.title ?? 'Settings';
  return (
    <div className="view flex min-w-0 flex-1 flex-col overflow-auto px-8 py-8">
      <Typography.Heading level={5} className="mb-6">
        {title}
      </Typography.Heading>
      {page === 'account' && <AccountPage />}
      {page === 'agents' && <AgentsPage />}
      {page === 'updates' && <UpdatesPage />}
      {page === 'about' && <AboutPage />}
    </div>
  );
});
