import { Logo } from './Logo';
import { useCallback, useEffect, useState } from 'react';
import {
  CircleCheckFill,
  Lock,
  LogoGithub,
  Sparkles,
  Terminal,
} from '@gravity-ui/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  Kbd,
  Label,
  ProgressBar,
  Separator,
  TextField,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type {
  AgentStatus,
  HostAuthStatus,
  TelemetryChoice,
  TelemetryStatus,
} from '../gen/contract';
import { api, CommandFailure } from '../core/api';
import { useDeviceLogin } from '../core/deviceLogin';
import { useRootStore, useUi } from '../stores/context';
import { Btn, Spinner } from './bits';
import { AccountStep, useAccountStatus } from './AccountCard';
import { DeviceLoginPanel } from './DeviceLoginPanel';
import { ProjectPicker } from './Projects';
import { SHARE_ROWS, WhatsCollectedLink } from './Privacy';
import { TELEMETRY_CLAIM } from './WhatsCollected';

type StepId =
  'github' | 'account' | 'telemetry' | 'agents' | 'projects' | 'done';
const STEP_TITLE: Record<StepId, string> = {
  github: 'GitHub',
  account: 'Account',
  telemetry: 'Sharing',
  agents: 'Agents',
  projects: 'Projects',
  done: 'Done',
};

/** Signing in to Theodore comes first when it's required (a WorkOS client
 *  id is configured), and can't be skipped. The sharing choice comes next,
 *  only when this build can send usage data or error reports at all. */
export function onboardingSteps(
  accountRequired: boolean,
  telemetryAvailable = false,
): StepId[] {
  return [
    ...(accountRequired ? (['account'] as const) : []),
    ...(telemetryAvailable ? (['telemetry'] as const) : []),
    'github',
    'agents',
    'projects',
    'done',
  ];
}

/** `loading` until `telemetry_status` answers; a failure counts as "no
 *  sink in this build" so onboarding never waits on it. */
type Telemetry = TelemetryStatus | 'loading' | 'none';

function useTelemetryStatus(): Telemetry {
  const [status, setStatus] = useState<Telemetry>('loading');
  useEffect(() => {
    let live = true;
    api.telemetryStatus().then(
      (s) => live && setStatus(s),
      () => live && setStatus('none'),
    );
    return () => {
      live = false;
    };
  }, []);
  return status;
}

/** Only Projects can be skipped; the sign-in, where it's a step, can't. */
export function skippable(id: StepId, hasProjects: boolean): boolean {
  return id === 'projects' && !hasProjects;
}

const SOURCE_LABEL: Record<HostAuthStatus['source'], string> = {
  keychain: 'a saved token',
  gh: 'your gh CLI login',
  env: 'GITHUB_TOKEN',
  none: 'nothing',
  sandbox: 'the sandbox (simulated host)',
};

/** First launch: sign in to the Theodore account where it's required
 *  (nothing else runs before that), connect GitHub (reusing `gh` if it's
 *  already logged in, or a pasted token), detect agent CLIs, then straight
 *  to the Inbox — projects arrive by opening a PR by URL, so that step is a
 *  no-op you can skip. */
export const Onboarding = observer(function Onboarding() {
  const store = useRootStore();
  const ui = useUi();
  const [picked, setStep] = useState(0);
  const [host, setHost] = useState<HostAuthStatus | null | 'unready'>(null);
  const [checking, setChecking] = useState(false);
  const [useToken, setUseToken] = useState(false);
  const [token, setToken] = useState('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const account = useAccountStatus();
  const telemetry = useTelemetryStatus();
  const telemetryAvailable =
    typeof telemetry === 'object' &&
    (telemetry.usage_available || telemetry.errors_available);
  // The app shows onboarding only once the account status is known; the
  // step list waits for the sharing status too, so it never shifts.
  const stepsKnown = account !== null && telemetry !== 'loading';
  const steps = onboardingSteps(account?.required ?? false, telemetryAvailable);
  // Signed out (or the session ended mid-way): back on the sign-in step,
  // and nothing past it runs.
  const locked = store.ephemeral.accountGate !== 'open';
  const step = locked ? 0 : picked;
  const id: StepId = steps[Math.min(step, steps.length - 1)] ?? 'done';

  // Both on, unless chosen before (onboarding was reset).
  const [chosen, setShare] = useState<TelemetryChoice | null>(null);
  const share: TelemetryChoice = chosen ?? {
    usage: typeof telemetry === 'object' ? (telemetry.usage ?? true) : true,
    errors: typeof telemetry === 'object' ? (telemetry.errors ?? true) : true,
  };
  const [saving, setSaving] = useState(false);

  // One event each time a step comes up.
  useEffect(() => {
    if (stepsKnown) void api.trackUi({ event: 'onboarding_step', step: id });
  }, [stepsKnown, id]);

  const checkHost = useCallback(() => {
    setChecking(true);
    void api
      .hostStatus()
      .then(setHost)
      .catch(() => setHost('unready'))
      .finally(() => setChecking(false));
  }, []);

  // Host and agent checks are work the core turns away until signed in.
  useEffect(() => {
    if (!locked) checkHost();
  }, [locked, checkHost]);
  useEffect(() => {
    if (!locked) void api.detectAgents().then(setAgents);
  }, [locked]);

  const deviceLogin = useDeviceLogin((s) => setHost(s), !locked);

  const connectWithToken = () => {
    setTokenError(null);
    setChecking(true);
    void api
      .setHostToken({ host: 'github', token: token.trim() })
      .then(setHost)
      .catch((e) =>
        setTokenError(e instanceof CommandFailure ? e.message : String(e)),
      )
      .finally(() => setChecking(false));
  };

  const connected = host !== null && host !== 'unready' && host.connected;
  // Projects says Skip until one is added.
  const skipped = (s: StepId) =>
    skippable(s, store.models.projects.all().length > 0);
  const skip = skipped(id);
  const canNext: Record<StepId, boolean> = {
    github: connected || host === 'unready',
    account: !!account?.user,
    telemetry: !saving,
    agents: agents != null,
    projects: true,
    done: true,
  };

  return (
    <div className="onboarding flex h-full items-center-safe justify-center-safe overflow-auto bg-background p-6">
      <Card className="w-full max-w-[600px] gap-0 p-0">
        <div className="flex flex-col gap-4 px-8 pb-6 pt-8">
          <div className="flex items-center gap-2.5">
            <Logo size={28} />
            <span className="font-semibold">Theodore</span>
            <span className="flex-1" />
            <span className="text-xs text-muted">
              Step {step + 1} of {steps.length}
            </span>
          </div>
          <ProgressBar
            aria-label="Setup progress"
            value={step + 1}
            maxValue={steps.length}
            size="sm"
          >
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
          <div className="flex gap-4 text-xs">
            {steps.map((s, i) => {
              // A skipped optional step isn't ticked off as done.
              const done = i < step && !skipped(s);
              return (
                <span
                  key={s}
                  className={
                    i === step
                      ? 'font-medium text-foreground'
                      : done
                        ? 'text-success'
                        : 'text-muted'
                  }
                >
                  {done ? '✓ ' : ''}
                  {STEP_TITLE[s]}
                </span>
              );
            })}
          </div>
        </div>
        <Separator />

        <div className="flex min-h-[300px] flex-col gap-4 px-8 py-6">
          {!stepsKnown && (
            <div className="grid flex-1 place-items-center">
              <Spinner />
            </div>
          )}
          {stepsKnown && id === 'github' && (
            <>
              <Typography.Heading level={4}>Connect GitHub</Typography.Heading>
              <Typography.Paragraph size="sm" color="muted">
                Reviews, threads, Viewed and checks are read and written via the
                GitHub API on your behalf. Theodore reuses{' '}
                <code className="font-mono">gh</code>'s login automatically if
                you're already signed in.
              </Typography.Paragraph>
              {host === 'unready' ? (
                <Alert status="warning">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>GitHub sign-in isn't wired up yet</Alert.Title>
                    <Alert.Description>
                      You can continue and paste a PR link into a new tab (⌘T)
                      once you're in.
                    </Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : connected && host ? (
                <Alert status="success">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>
                      Signed in {host.login ? `as ${host.login}` : ''}
                    </Alert.Title>
                    <Alert.Description>
                      Using {SOURCE_LABEL[host.source]}.
                    </Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : useToken ? (
                <div className="flex flex-col gap-3">
                  <TextField value={token} onChange={setToken} type="password">
                    <Label>Personal access token</Label>
                    <Input placeholder="ghp_…" className="font-mono" />
                  </TextField>
                  {tokenError && (
                    <span className="text-xs text-danger">{tokenError}</span>
                  )}
                  <div className="flex gap-2">
                    <Button
                      isDisabled={token.trim().length < 8}
                      onPress={connectWithToken}
                      isPending={checking}
                    >
                      {({ isPending }) => (
                        <>
                          {isPending && <Spinner />}
                          Verify token
                        </>
                      )}
                    </Button>
                    <Button variant="ghost" onPress={() => setUseToken(false)}>
                      Back
                    </Button>
                  </div>
                </div>
              ) : deviceLogin.phase !== 'idle' ? (
                <div className="flex flex-col gap-3">
                  <DeviceLoginPanel state={deviceLogin} />
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <Button
                    className="gh-connect self-start"
                    onPress={checkHost}
                    isPending={checking}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? (
                          <Spinner />
                        ) : (
                          <LogoGithub className="size-4" />
                        )}
                        {isPending ? 'Checking…' : 'Check gh / keychain again'}
                      </>
                    )}
                  </Button>
                  {deviceLogin.available && (
                    <Button
                      variant="ghost"
                      className="gh-device-login self-start"
                      onPress={deviceLogin.start}
                    >
                      <LogoGithub className="size-4" />
                      Sign in with GitHub
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    className="self-start px-0 text-muted"
                    onPress={() => setUseToken(true)}
                  >
                    <Lock className="size-4" />
                    Paste a token manually
                  </Button>
                </div>
              )}
            </>
          )}

          {stepsKnown && id === 'account' && <AccountStep />}

          {stepsKnown &&
            id === 'telemetry' &&
            typeof telemetry === 'object' && (
              <TelemetryStep
                status={telemetry}
                value={share}
                onChange={setShare}
              />
            )}

          {id === 'agents' && (
            <>
              <Typography.Heading level={4}>Agent CLIs</Typography.Heading>
              <Typography.Paragraph size="sm" color="muted">
                Found in <code className="font-mono">PATH</code>. They run in
                the PR worktree and report findings through the local MCP
                server.
              </Typography.Paragraph>
              {!agents ? (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <Spinner /> Looking for claude, codex, gemini…
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {agents.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center gap-3 rounded-2xl px-3 py-2.5 hover:bg-default/50"
                    >
                      <Terminal className="size-4 text-muted" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="font-mono text-sm font-medium">
                          {a.id}
                        </span>
                        {a.path && (
                          <span className="font-mono text-xs text-muted">
                            {a.path}
                          </span>
                        )}
                      </span>
                      <span className="text-sm text-muted">
                        {a.installed ? (a.version ?? 'found') : 'not found'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {id === 'projects' && (
            <>
              <Typography.Heading level={4}>Projects</Typography.Heading>
              <Typography.Paragraph size="sm" color="muted">
                Connect a GitHub repository, or point Theodore at a local
                folder. Optional — skip it and paste a pull request link into a
                new tab (⌘T) instead.
              </Typography.Paragraph>
              <ProjectPicker />
            </>
          )}

          {id === 'done' && (
            <>
              <Typography.Heading level={4}>Done</Typography.Heading>
              <Typography.Paragraph size="sm" color="muted">
                A few shortcuts to start:
              </Typography.Paragraph>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-sm">
                {[
                  ['⌘K', 'any action'],
                  ['J / K', 'move through list'],
                  ['Space', 'preview PR'],
                  ['⏎', 'open review'],
                  ['/', 'skill in chat'],
                  ['?', 'all shortcuts'],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2.5">
                    <Kbd className="min-w-12 justify-center">{k}</Kbd>
                    <span className="text-muted">{v}</span>
                  </div>
                ))}
              </div>
              <Alert status="accent">
                <Alert.Indicator>
                  <Sparkles className="size-4" />
                </Alert.Indicator>
                <Alert.Content>
                  <Alert.Description>
                    Grouping runs once when you open a PR. Skills, chat and
                    fixes run only when you ask.
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            </>
          )}
        </div>

        <Separator />
        <div className="flex items-center gap-2 px-8 py-4">
          {step > 0 && (
            <Button variant="tertiary" onPress={() => setStep(step - 1)}>
              Back
            </Button>
          )}
          <span className="flex-1" />
          {step < steps.length - 1 ? (
            <Button
              className="onb-next"
              // Skipping an optional step is quiet: the step's own
              // buttons are the call to action.
              variant={skip ? 'tertiary' : 'primary'}
              isDisabled={!canNext[id]}
              isPending={saving}
              onPress={() => {
                if (id !== 'telemetry' || typeof telemetry !== 'object')
                  return setStep(step + 1);
                // The choice is recorded before anything is sent, and
                // before moving on.
                setSaving(true);
                void api
                  .setTelemetry({
                    usage: telemetry.usage_available && share.usage,
                    errors: telemetry.errors_available && share.errors,
                  })
                  .then(() => setStep(step + 1))
                  .catch(() => {
                    // toasted by api.ts; stay on the step
                  })
                  .finally(() => setSaving(false));
              }}
            >
              {skip ? 'Skip' : 'Next'}
            </Button>
          ) : (
            <Btn tone="primary" onPress={() => ui.finishOnboarding()}>
              <CircleCheckFill className="size-4" />
              Open Inbox
            </Btn>
          )}
        </div>
      </Card>
    </div>
  );
});

function TelemetryStep({
  status,
  value,
  onChange,
}: {
  status: TelemetryStatus;
  value: TelemetryChoice;
  onChange: (v: TelemetryChoice) => void;
}) {
  return (
    <>
      <Typography.Heading level={4}>Help improve Theodore</Typography.Heading>
      <Typography.Paragraph size="sm" color="muted">
        Choose what Theodore may send to help fix bugs and improve features.
        Nothing is sent until you press Next. {TELEMETRY_CLAIM}
      </Typography.Paragraph>
      <div className="flex flex-col gap-3">
        {SHARE_ROWS.map(({ kind, label, hint }) => {
          const available =
            kind === 'usage' ? status.usage_available : status.errors_available;
          return (
            <Checkbox
              key={kind}
              className={`share-${kind}`}
              isSelected={available && value[kind]}
              isDisabled={!available}
              onChange={(v) => onChange({ ...value, [kind]: v })}
            >
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <span className="flex flex-col">
                  <span className="text-sm">{label}</span>
                  <span className="text-xs text-muted">
                    {available ? hint : 'Not configured in this build'}
                  </span>
                </span>
              </Checkbox.Content>
            </Checkbox>
          );
        })}
      </div>
      <WhatsCollectedLink />
    </>
  );
}
