/**
 * A mock `FleetClient` + `AuthClient` that fill the zustand store with
 * realistic data, so screens render (and tests run) without a backend.
 * `createMock()` seeds the store and returns the services plus a `calls` log.
 */
import type {
  AuthClient,
  Organization,
  Session,
  SignInResult,
} from '../auth/types';
import type {
  FleetAgentView,
  FleetClient,
  FleetDeviceView,
  FleetSnapshot,
  QuestionView,
  SpaceLine,
  SpaceView,
} from '../fleet/types';
import type { ChatMessage } from '../fleet/contract';
import type { SpaceMirror } from '../fleet/mirror';
import type { Services } from '../services';
import { initialFleet, useFleetState } from '../state/fleet';

const FINGERPRINT_ME = '4f2a 9c1e b07d 63a8 e5d4 1b92 7c3f a0e6';

const CLAUDE_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** What the MacBook runs for remote spaces: Claude (default) and Codex. */
export const mockAgents: FleetAgentView[] = [
  {
    id: 'claude',
    label: 'Claude',
    defaultModel: 'claude-opus-4-1',
    defaultEffort: 'high',
    models: [
      {
        id: 'claude-opus-4-1',
        label: 'Opus 4.1',
        efforts: CLAUDE_LEVELS,
        defaultEffort: 'high',
      },
      {
        id: 'claude-sonnet-4-5',
        label: 'Sonnet 4.5',
        efforts: CLAUDE_LEVELS,
        defaultEffort: 'medium',
      },
      {
        id: 'claude-haiku-4-5',
        label: 'Haiku 4.5',
        efforts: [],
        defaultEffort: null,
      },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    defaultModel: 'gpt-5-codex',
    defaultEffort: 'medium',
    models: [
      {
        id: 'gpt-5-codex',
        label: 'GPT-5 Codex',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
    ],
  },
];

export const mockDevices: FleetDeviceView[] = [
  {
    deviceId: 'dev-me',
    name: 'Jean’s iPhone',
    kind: 'mobile',
    os: 'ios',
    online: true,
    acceptsRemote: false,
    maxMode: 'ask',
    projects: [],
    agents: [],
    publicKey: 'pk-me',
    fingerprint: FINGERPRINT_ME,
    trusted: false,
    thisDevice: true,
    mcpAuto: [],
  },
  {
    deviceId: 'dev-mac',
    name: 'MacBook Pro',
    kind: 'desktop',
    os: 'macos',
    online: true,
    acceptsRemote: true,
    maxMode: 'edit',
    projects: [
      { id: 'p-theodore', name: 'theodore' },
      { id: 'p-tama', name: 'tamagochi' },
    ],
    agents: mockAgents,
    publicKey: 'pk-mac',
    fingerprint: 'a1b2 c3d4 e5f6 0718 293a 4b5c 6d7e 8f90',
    trusted: true,
    thisDevice: false,
    mcpAuto: [],
  },
  {
    deviceId: 'dev-box',
    name: 'build-box',
    kind: 'daemon',
    os: 'linux',
    online: true,
    acceptsRemote: true,
    maxMode: 'run',
    projects: [{ id: 'p-api', name: 'api' }],
    // An older host: lists no agents.
    agents: [],
    publicKey: 'pk-box',
    fingerprint: '0f1e 2d3c 4b5a 6978 8796 a5b4 c3d2 e1f0',
    trusted: true,
    thisDevice: false,
    mcpAuto: [],
  },
  {
    deviceId: 'dev-work',
    name: 'Work Mac',
    kind: 'desktop',
    os: 'macos',
    online: false,
    acceptsRemote: true,
    maxMode: 'plan',
    projects: [{ id: 'p-web', name: 'web' }],
    agents: [],
    publicKey: 'pk-work',
    fingerprint: '9988 7766 5544 3322 1100 ffee ddcc bbaa',
    trusted: false,
    thisDevice: false,
    mcpAuto: [],
  },
  {
    deviceId: 'dev-new',
    name: 'Studio Mac',
    kind: 'desktop',
    os: 'macos',
    online: true,
    acceptsRemote: true,
    maxMode: 'edit',
    projects: [{ id: 'p-studio', name: 'studio' }],
    agents: [],
    publicKey: 'pk-new',
    fingerprint: 'dead beef cafe f00d 1234 5678 9abc def0',
    trusted: false,
    thisDevice: false,
    mcpAuto: [],
  },
];

export const mockQuestion: QuestionView = {
  askId: 'ask-1',
  space: 'sp-waiting',
  from: 'MacBook Pro · fix flaky login test',
  questions: [
    {
      question: 'Which test runner should I use for the fix?',
      options: ['vitest', 'jest', 'playwright'],
      multi: false,
    },
    {
      question: 'Which parts may I touch?',
      options: ['auth', 'session', 'tests'],
      multi: true,
    },
  ],
};

export const mockSpaces: SpaceView[] = [
  {
    space: 'sp-idle',
    hostDevice: 'dev-mac',
    hostName: 'MacBook Pro',
    originDevice: 'dev-me',
    projectName: 'theodore',
    name: 'tidy the settings page',
    branch: 'agent/tidy-settings',
    status: 'idle',
    mode: 'edit',
    lastReply:
      'Done. I moved the **account** card into its own file and added a test. See [the diff](https://example.com).',
    question: null,
    startedHere: true,
    error: null,
  },
  {
    space: 'sp-running',
    hostDevice: 'dev-box',
    hostName: 'build-box',
    originDevice: 'dev-me',
    projectName: 'api',
    name: 'speed up the build',
    branch: 'agent/speed-build',
    status: 'running',
    mode: 'run',
    lastReply: null,
    question: null,
    startedHere: true,
    error: null,
  },
  {
    space: 'sp-waiting',
    hostDevice: 'dev-mac',
    hostName: 'MacBook Pro',
    originDevice: 'dev-mac',
    projectName: 'tamagochi',
    name: 'fix flaky login test',
    branch: 'agent/flaky-login',
    status: 'waiting',
    mode: 'edit',
    lastReply: 'I found two candidates for the flake and need a decision.',
    question: mockQuestion,
    startedHere: false,
    error: null,
  },
  {
    space: 'sp-failed',
    hostDevice: 'dev-box',
    hostName: 'build-box',
    originDevice: 'dev-me',
    projectName: 'api',
    name: '',
    branch: 'agent/migrate-db',
    status: 'failed',
    mode: 'plan',
    lastReply: null,
    question: null,
    startedHere: true,
    error: 'The project is not a git repository on build-box.',
  },
];

export const mockLines: Record<string, SpaceLine[]> = {
  'sp-waiting': [
    { seq: 1, kind: 'started', text: 'Started on MacBook Pro' },
    { seq: 2, kind: 'turn', text: 'The login test is flaky, please fix it.' },
    { seq: 3, kind: 'tool', text: 'Read tests/login.test.ts' },
    {
      seq: 4,
      kind: 'tool',
      text: 'Run vitest tests/login.test.ts --repeat 20',
    },
    {
      seq: 5,
      kind: 'reply',
      text: 'It fails 3 of 20 runs: the session cookie is read before it is written.',
    },
    { seq: 6, kind: 'gap', text: '' },
    { seq: 7, kind: 'status', text: 'Waiting for your answer' },
    { seq: 8, kind: 'question', text: 'Which test runner should I use?' },
  ],
  'sp-idle': [
    { seq: 1, kind: 'started', text: 'Started on MacBook Pro' },
    { seq: 2, kind: 'turn', text: 'Tidy the settings page.' },
    { seq: 3, kind: 'reply', text: 'Done. The account card has its own file.' },
    { seq: 4, kind: 'ended', text: 'Turn finished' },
  ],
};

const T0 = Date.UTC(2026, 10, 14, 15, 0, 0);
const msg = (
  m: Partial<ChatMessage> & Pick<ChatMessage, 'id'>,
): ChatMessage => ({
  pr: 'space:sp-idle',
  author: { kind: 'agent', agent: 'claude' },
  text: '',
  at: T0,
  ...m,
});

/** Mirrored rows: sp-idle ends in a plan to approve, sp-running is mid-turn. */
export const mockMirrors: Record<string, SpaceMirror> = {
  'sp-idle': {
    space: {
      id: 'sp-idle',
      name: 'tidy-settings',
      goal: 'Tidy the settings page',
      title: 'Tidy the settings page',
      branch: 'agent/tidy-settings',
      status: 'idle',
      agent: 'claude',
      mode: 'plan',
      turns: 1,
      run: null,
      turn_log: [
        { message: 'm1', reply: 'm2', plan: 'Move the account card…' },
      ],
      build_mode: 'edit',
      question: null,
      created_at: T0,
      updated_at: T0 + 90_000,
    },
    messages: {
      m1: msg({
        id: 'm1',
        author: { kind: 'me' },
        text: 'Tidy the settings page.',
      }),
      m2: msg({
        id: 'm2',
        at: T0 + 72_000,
        duration_ms: 72_000,
        run: 'space:sp-idle:m1',
        activity: [
          { kind: 'thinking', text: 'The page mixes **account** and _labs_.' },
          {
            kind: 'tool',
            name: 'Read',
            target: 'ui/Settings.tsx',
            ok: true,
            summary: '412 lines',
          },
          {
            kind: 'tool',
            name: 'Read',
            target: 'ui/AccountCard.tsx',
            ok: true,
            summary: '88 lines',
          },
          {
            kind: 'tool',
            name: 'Grep',
            target: 'ui',
            detail: 'AccountCard',
            ok: true,
            summary: '3 matches',
          },
          {
            kind: 'tool',
            name: 'Bash',
            target: 'pnpm test settings',
            detail: 'Run the settings tests',
            ok: false,
          },
        ],
        changed_files: [
          { path: 'ui/Settings.tsx', additions: 12, deletions: 40 },
          { path: 'ui/AccountCard.tsx', additions: 30, deletions: 2 },
        ],
        text: [
          '## Plan',
          '',
          '1. Move the **account** card into `AccountCard.tsx`.',
          '2. Keep labs under one heading:',
          '   - `spaces.notify`',
          '   - `fleet.remote`',
          '3. Verify with `pnpm test settings`.',
          '',
          'See [the design](https://example.com/design) — no image: ![shot](https://example.com/a.png)',
          '',
          '```ts',
          'export function AccountCard() {}',
          '```',
        ].join('\n'),
      }),
    },
    steps: {},
  },
  'sp-running': {
    space: null,
    messages: {
      r1: msg({
        id: 'r1',
        pr: 'space:sp-running',
        author: { kind: 'me' },
        text: 'Speed up the build.',
      }),
    },
    steps: {
      'space:sp-running:r1:0': {
        run: 'space:sp-running:r1',
        n: 0,
        step: {
          kind: 'tool',
          name: 'Bash',
          target: 'cargo build --timings',
          ok: true,
        },
      },
      'space:sp-running:r1:1': {
        run: 'space:sp-running:r1',
        n: 1,
        step: {
          kind: 'text',
          text: 'The `grouping` crate takes 40% of the build.',
        },
      },
      'space:sp-running:r1:2': {
        run: 'space:sp-running:r1',
        n: 2,
        step: {
          kind: 'tool',
          name: 'Edit',
          target: 'Cargo.toml',
          ok: null,
          added: 3,
          removed: 1,
        },
      },
    },
  },
};

export const mockSession: Session = {
  userId: 'user-1',
  email: 'jean@example.com',
  name: 'Jean Isahakyan',
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  organizationId: 'org-personal',
  role: 'admin',
};

export const mockOrganizations: Organization[] = [
  { id: 'org-personal', name: 'Jean', role: 'admin', personal: true },
  { id: 'org-acme', name: 'Acme', role: 'member', personal: false },
];

export interface MockCall {
  method: string;
  args: unknown[];
}

export interface MockOptions {
  /** Makes the named client method reject with this message. */
  failing?: Partial<Record<string, string>>;
  /** Start with this much of the fixture; defaults to all. */
  snapshot?: Partial<FleetSnapshot>;
}

export interface Mock {
  services: Services;
  calls: MockCall[];
  /** The session the mock auth client currently holds. */
  session(): Session | null;
}

/** The seeded snapshot: connected, fixtures for every screen. */
export function mockSnapshot(over: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return {
    connection: 'connected',
    error: null,
    deviceId: 'dev-me',
    fingerprint: FINGERPRINT_ME,
    devices: mockDevices.map((d) => ({ ...d })),
    spaces: mockSpaces.map((s) => ({ ...s })),
    lines: { ...mockLines },
    mirrors: { ...mockMirrors },
    questions: [{ ...mockQuestion, questions: [...mockQuestion.questions] }],
    confirms: [],
    ...over,
  };
}

export function createMock(options: MockOptions = {}): Mock {
  const calls: MockCall[] = [];
  const failing = options.failing ?? {};
  let session: Session | null = { ...mockSession };
  const listeners = new Set<(s: Session | null) => void>();
  let counter = 0;

  useFleetState.setState(mockSnapshot(options.snapshot), true);

  const call = async (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
    const message = failing[method];
    if (message) throw new Error(message);
  };
  const patchSpace = (id: string, patch: Partial<SpaceView>) =>
    useFleetState.setState((s) => ({
      spaces: s.spaces.map((x) => (x.space === id ? { ...x, ...patch } : x)),
    }));
  const appendLine = (id: string, kind: SpaceLine['kind'], text: string) =>
    useFleetState.setState((s) => {
      const lines = s.lines[id] ?? [];
      const seq = (lines[lines.length - 1]?.seq ?? 0) + 1;
      return { lines: { ...s.lines, [id]: [...lines, { seq, kind, text }] } };
    });

  const fleet: FleetClient = {
    async start() {
      await call('start');
    },
    stop() {
      calls.push({ method: 'stop', args: [] });
    },
    async startSpace(req) {
      await call('startSpace', req);
      counter += 1;
      const device = useFleetState
        .getState()
        .devices.find((d) => d.deviceId === req.deviceId);
      const space: SpaceView = {
        space: `sp-new-${counter}`,
        hostDevice: req.deviceId,
        hostName: device?.name ?? 'unknown',
        originDevice: useFleetState.getState().deviceId ?? '',
        projectName:
          device?.projects.find((p) => p.id === req.projectId)?.name ?? '',
        name: req.goal,
        branch: `agent/new-${counter}`,
        status: 'starting',
        mode: req.mode,
        lastReply: null,
        question: null,
        startedHere: true,
        error: null,
      };
      useFleetState.setState((s) => ({ spaces: [space, ...s.spaces] }));
      return space;
    },
    async send(space, text, mode = null, picks) {
      await call('send', space, text, mode, ...(picks ? [picks] : []));
      appendLine(space, 'turn', text);
      patchSpace(space, { status: 'running' });
    },
    async stopSpace(space) {
      await call('stopSpace', space);
      patchSpace(space, { status: 'stopped' });
    },
    async answer(space, askId, answers) {
      await call('answer', space, askId, answers);
      patchSpace(space, { question: null, status: 'running' });
      useFleetState.setState((s) => ({
        questions: s.questions.filter((q) => q.askId !== askId),
      }));
    },
    async trust(deviceId, publicKey) {
      await call('trust', deviceId, publicKey);
      useFleetState.setState((s) => ({
        devices: s.devices.map((d) =>
          d.deviceId === deviceId ? { ...d, trusted: true } : d,
        ),
      }));
    },
    async untrust(deviceId) {
      await call('untrust', deviceId);
      useFleetState.setState((s) => ({
        devices: s.devices.map((d) =>
          d.deviceId === deviceId ? { ...d, trusted: false } : d,
        ),
      }));
    },
    async lines(space) {
      await call('lines', space);
      return useFleetState.getState().lines[space] ?? [];
    },
    async registerPush(token) {
      await call('registerPush', token);
    },
    async answerOverHttp(space, askId, answers, hostDevice) {
      await call('answerOverHttp', space, askId, answers, hostDevice);
    },
    async confirm(hostDevice, confirmId, allow) {
      await call('confirm', hostDevice, confirmId, allow);
      useFleetState.setState((s) => ({
        confirms: s.confirms.filter((c) => c.confirmId !== confirmId),
      }));
    },
    async confirmOverHttp(hostDevice, confirmId, allow) {
      await call('confirmOverHttp', hostDevice, confirmId, allow);
    },
    async setMcpAuto(hostDevice, mcpDevice, auto, untilMs) {
      await call('setMcpAuto', hostDevice, mcpDevice, auto, untilMs);
      useFleetState.setState((s) => ({
        devices: s.devices.map((d) =>
          d.deviceId === hostDevice
            ? {
                ...d,
                mcpAuto: d.mcpAuto.map((m) =>
                  m.deviceId === mcpDevice
                    ? { ...m, auto, untilMs: auto === 'off' ? null : untilMs }
                    : m,
                ),
              }
            : d,
        ),
      }));
    },
  };

  const notify = () => listeners.forEach((l) => l(session));
  const auth: AuthClient = {
    async current() {
      return session;
    },
    async signIn(): Promise<SignInResult> {
      await call('signIn');
      session = { ...mockSession };
      notify();
      return { kind: 'signed_in', session };
    },
    async chooseOrganization(id) {
      await call('chooseOrganization', id);
      session = { ...mockSession, organizationId: id };
      notify();
      return { kind: 'signed_in', session };
    },
    async switchOrganization(id) {
      await call('switchOrganization', id);
      session = { ...(session ?? mockSession), organizationId: id };
      notify();
      return session;
    },
    async organizations() {
      await call('organizations');
      return mockOrganizations;
    },
    async accessToken() {
      return session?.accessToken ?? null;
    },
    async signOut() {
      await call('signOut');
      session = null;
      notify();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return { services: { auth, fleet }, calls, session: () => session };
}

/** Back to an empty store (between tests). */
export function resetFleetState(): void {
  useFleetState.setState(initialFleet, true);
}
