/** Fleet fixtures for tests. */
import type {
  FleetDevice,
  FleetQuestion,
  FleetRemoteSpace,
  FleetStatus,
  FleetTrustNeeded,
} from '../gen/contract';

export const device = (over: Partial<FleetDevice> = {}): FleetDevice => ({
  device_id: 'd2',
  name: 'Studio Mac',
  os: 'macos',
  kind: 'desktop',
  online: true,
  last_seen_ms: 0,
  projects: [
    { id: 'p1', name: 'app' },
    { id: 'p2', name: 'api' },
  ],
  accepts_remote: true,
  max_mode: 'edit',
  fingerprint: 'a1b2 c3d4 e5f6 0718 9abc def0 1234 5678',
  public_key: 'pk-studio-mac',
  trusted: false,
  this_device: false,
  ...over,
});

export const thisDevice = (over: Partial<FleetDevice> = {}): FleetDevice =>
  device({
    device_id: 'd1',
    name: 'Laptop',
    fingerprint: '1111 2222 3333 4444 5555 6666 7777 8888',
    public_key: 'pk-laptop',
    this_device: true,
    projects: [],
    accepts_remote: false,
    ...over,
  });

export const status = (over: Partial<FleetStatus> = {}): FleetStatus => ({
  available: true,
  enabled: true,
  connected: true,
  device_id: 'd1',
  name: 'Laptop',
  fingerprint: '1111 2222 3333 4444 5555 6666 7777 8888',
  accept_remote: false,
  max_mode: 'edit',
  devices: [thisDevice(), device()],
  error: null,
  ...over,
});

export const question = (over: Partial<FleetQuestion> = {}): FleetQuestion => ({
  ask_id: 'ask1',
  space: 'rs_1',
  from: 'Studio Mac · fix login',
  questions: [
    {
      question: 'Which database?',
      options: ['sqlite', 'postgres'],
      multi: false,
    },
  ],
  via: 'active',
  ...over,
});

export const remoteSpace = (
  over: Partial<FleetRemoteSpace> = {},
): FleetRemoteSpace => ({
  space: 'rs_1',
  host_device: 'd2',
  host_name: 'Studio Mac',
  origin_device: 'd1',
  project_name: 'app',
  name: 'fix login',
  branch: 'fix-login',
  status: 'idle',
  mode: 'edit',
  depth: 0,
  parent: null,
  last_reply: null,
  question: null,
  hosted_here: false,
  local_space: null,
  error: null,
  ...over,
});

/** "Studio Mac wants to run spaces here": the key it asked with. */
export const trustNeeded = (
  over: Partial<FleetTrustNeeded> = {},
): FleetTrustNeeded => ({
  device_id: 'd2',
  device_name: 'Studio Mac',
  fingerprint: 'a1b2 c3d4 e5f6 0718 9abc def0 1234 5678',
  public_key: 'pk-studio-mac-asked',
  ...over,
});
