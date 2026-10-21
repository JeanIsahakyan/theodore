import { Logo } from './Logo';
import { useEffect, useState } from 'react';
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
  Input,
  Kbd,
  Label,
  ProgressBar,
  Separator,
  TextField,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { AgentStatus, HostAuthStatus } from '../gen/contract';
import { api, CommandFailure } from '../core/api';
import { useDeviceLogin } from '../core/deviceLogin';
import { useRootStore, useUi } from '../stores/context';
import { Btn, Spinner } from './bits';
import { DeviceLoginPanel } from './DeviceLoginPanel';
import { ProjectPicker } from './Projects';

const STEPS = ['GitHub', 'Agents', 'Projects', 'Done'];

const SOURCE_LABEL: Record<HostAuthStatus['source'], string> = {
  keychain: 'a saved token',
  gh: 'your gh CLI login',
  env: 'GITHUB_TOKEN',
  none: 'nothing',
  sandbox: 'the sandbox (simulated host)',
};

/** First launch: connect GitHub (reusing `gh` if it's already logged in, or a
 *  pasted token), detect agent CLIs, then straight to the Inbox — projects
 *  arrive by opening a PR by URL, so that step is a no-op you can skip. */
export const Onboarding = observer(function Onboarding() {
  const store = useRootStore();
  const ui = useUi();
  const [step, setStep] = useState(0);
  const [host, setHost] = useState<HostAuthStatus | null | 'unready'>(null);
  const [checking, setChecking] = useState(false);
  const [useToken, setUseToken] = useState(false);
  const [token, setToken] = useState('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);

  const checkHost = () => {
    setChecking(true);
    void api
      .hostStatus()
      .then(setHost)
      .catch(() => setHost('unready'))
      .finally(() => setChecking(false));
  };

  useEffect(checkHost, []);
  useEffect(() => {
    void api.detectAgents().then(setAgents);
  }, []);

  const deviceLogin = useDeviceLogin((s) => setHost(s));

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
  const canNext = [connected || host === 'unready', agents != null, true, true][
    step
  ];

  return (
    <div className="onboarding flex h-full items-center-safe justify-center-safe overflow-auto bg-background p-6">
      <Card className="w-full max-w-[600px] gap-0 p-0">
        <div className="flex flex-col gap-4 px-8 pb-6 pt-8">
          <div className="flex items-center gap-2.5">
            <Logo size={28} />
            <span className="font-semibold">Theodore</span>
            <span className="flex-1" />
            <span className="text-xs text-muted">
              Step {step + 1} of {STEPS.length}
            </span>
          </div>
          <ProgressBar
            aria-label="Setup progress"
            value={step + 1}
            maxValue={STEPS.length}
            size="sm"
          >
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
          <div className="flex gap-4 text-xs">
            {STEPS.map((s, i) => (
              <span
                key={s}
                className={
                  i === step
                    ? 'font-medium text-foreground'
                    : i < step
                      ? 'text-success'
                      : 'text-muted'
                }
              >
                {i < step ? '✓ ' : ''}
                {s}
              </span>
            ))}
          </div>
        </div>
        <Separator />

        <div className="flex min-h-[300px] flex-col gap-4 px-8 py-6">
          {step === 0 && (
            <>
              <Typography.Heading level={4}>Connect GitHub</Typography.Heading>
              <Typography.Paragraph size="sm" color="muted">
                Reviews, threads, Viewed and checks are read and written via the
                GitHub API on your behalf. Theodore reuses{' '}
                <code className="font-mono">gh</code>'s login automatically if
                you're already signed in. GitLab and Bitbucket accounts connect
                afterward, from Settings → Account.
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

          {step === 1 && (
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

          {step === 2 && (
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

          {step === 3 && (
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
                    fixes run only when you ask; a per-PR budget caps spend.
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
          {step < STEPS.length - 1 ? (
            <Button
              className="onb-next"
              isDisabled={!canNext}
              onPress={() => setStep(step + 1)}
            >
              {step === 2 && store.models.projects.all().length === 0
                ? 'Skip'
                : 'Next'}
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
