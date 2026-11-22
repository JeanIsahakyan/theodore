/**
 * Push notifications on the phone (docs/mobile.md). The Expo calls live here;
 * the payload contract and the decisions are pure and live in `contract.ts`
 * (tested in `test/push-contract.test.ts`). Read `README.md` first.
 */
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { AccountsClient, AuthClient } from '../auth/types';
import type { Services } from '../services';
import { createDataStorage } from '../fleet/data';
import { savedSpaces } from '../fleet/saved';
import type { FleetClient, PushIdentity } from '../fleet/types';
import { setSwitching } from '../state/accounts';
import {
  ACTION_ALLOW,
  ACTION_DENY,
  ACTION_OPEN,
  ACTION_REPLY,
  CATEGORY_CONFIRM,
  CATEGORY_TEXT,
  HOME_PATH,
  classifyResponse,
  optionAction,
  optionCategory,
  responseKey,
  showInForeground,
  spacePath,
} from './contract';
import { accountScopes, pushTarget, type PushTarget } from './route';

const CHANNEL = 'default';
const PREF_KEY = 'theodore.notifications.enabled';

let activeSpace: () => string | null = () => null;

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL, {
    name: 'Questions and finished spaces',
    importance: AndroidImportance.HIGH,
  });
}

const noForeground = {
  isAuthenticationRequired: false,
  isDestructive: false,
  opensAppToForeground: false,
};

async function registerCategories(): Promise<void> {
  const reply = {
    identifier: ACTION_REPLY,
    buttonTitle: 'Reply',
    options: noForeground,
    textInput: { placeholder: 'Your answer', submitButtonTitle: 'Send' },
  };
  const option = (i: number) => ({
    identifier: optionAction(i),
    buttonTitle: String(i + 1),
    options: noForeground,
  });
  await Promise.all([
    Notifications.setNotificationCategoryAsync(CATEGORY_TEXT, [
      reply,
      {
        identifier: ACTION_OPEN,
        buttonTitle: 'Open',
        options: { ...noForeground, opensAppToForeground: true },
      },
    ]),
    Notifications.setNotificationCategoryAsync(optionCategory(2), [
      option(0),
      option(1),
      reply,
    ]),
    Notifications.setNotificationCategoryAsync(optionCategory(3), [
      option(0),
      option(1),
      option(2),
    ]),
    Notifications.setNotificationCategoryAsync(CATEGORY_CONFIRM, [
      {
        identifier: ACTION_DENY,
        buttonTitle: 'Deny',
        options: { ...noForeground, isDestructive: true },
      },
      { identifier: ACTION_ALLOW, buttonTitle: 'Allow', options: noForeground },
    ]),
  ]);
}

/**
 * Call once at startup, before any screen renders: foreground handler, the
 * action categories, the Android channel. `activeSpaceId` tells the handler
 * which space is on screen so its own pushes aren't bannered.
 */
export async function setupNotifications(opts?: {
  activeSpaceId?: () => string | null;
}): Promise<void> {
  if (Platform.OS === 'web') return;
  if (opts?.activeSpaceId) activeSpace = opts.activeSpaceId;
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const show = showInForeground(n.request.content.data, activeSpace());
      return {
        shouldShowBanner: show,
        shouldShowList: show,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    },
  });
  await ensureChannel();
  await registerCategories();
}

/** The persisted preference (default on). */
export async function getNotificationsEnabled(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(PREF_KEY)) !== 'off';
  } catch {
    return true;
  }
}

let tokenSub: { remove(): void } | null = null;

/**
 * This device's Expo push token, asking for permission first. `null` (never
 * throws) on web, on simulators/emulators (no push token there), when the
 * user turned notifications off, when permission is denied, when the build
 * has no EAS `projectId`, or when the token request fails (offline).
 */
export async function getPushToken(): Promise<string | null> {
  if (Platform.OS === 'web' || !Device.isDevice) return null;
  if (!(await getNotificationsEnabled())) return null;
  try {
    // Android 13+ shows the permission prompt only once a channel exists.
    await ensureChannel();
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) {
      perm = await Notifications.requestPermissionsAsync();
    }
    if (!perm.granted) return null;
    const projectId: string | undefined =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;
    if (!projectId) {
      console.warn('push: no EAS projectId in app config; not registering');
      return null;
    }
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch (e) {
    console.warn('push: no token', e);
    return null;
  }
}

/**
 * Gets the token and hands it to the cloud for the connected account and
 * org. A no-op when there is none (see `getPushToken`); offline, it runs
 * again at the next start.
 */
export async function registerForPush(fleet: FleetClient): Promise<void> {
  const token = await getPushToken();
  if (!token) return;
  try {
    await fleet.registerPush(token);
    // The native token rotating means the Expo token may change: register again.
    tokenSub ??= Notifications.addPushTokenListener(() => {
      void registerForPush(fleet);
    });
  } catch (e) {
    console.warn('push: registration failed', e);
  }
}

/**
 * The Settings switch: persists the choice, off tells the cloud to forget this
 * device's token, on registers again.
 */
export async function setNotificationsEnabled(
  fleet: FleetClient,
  on: boolean,
): Promise<void> {
  try {
    await SecureStore.setItemAsync(PREF_KEY, on ? 'on' : 'off');
  } catch (e) {
    console.warn('push: could not persist the preference', e);
  }
  if (on) await registerForPush(fleet);
  else await fleet.registerPush(null);
}

const handled = new Set<string>();

/** What the handler needs of the app's services. */
export type PushServices = Pick<Services, 'fleet' | 'auth' | 'accounts'>;

/**
 * Which account a push's space belongs to (`./route.ts`), from the saved
 * sets of every account here. Anything failing reads as "here".
 */
async function targetOf(
  space: string,
  { auth, accounts }: Pick<PushServices, 'auth' | 'accounts'>,
): Promise<PushTarget> {
  try {
    const active = await auth.current();
    const list = accounts.accounts();
    // One account in one org: nowhere else the space could be.
    if (list.length <= 1 && (list[0]?.orgs.length ?? 0) <= 1)
      return { kind: 'here' };
    const saved = savedSpaces(createDataStorage());
    const sets = await Promise.all(
      accountScopes(list).map(async (s) => ({
        ...s,
        spaces: await saved.spacesOf(s.scope),
      })),
    );
    return pushTarget(
      space,
      sets,
      active ? { userId: active.userId, orgId: active.organizationId } : null,
    );
  } catch (e) {
    console.warn('push: could not tell the account of a space', e);
    return { kind: 'here' };
  }
}

/** The target account's token in the space's org (a one-shot request). */
async function identityFor(
  target: PushTarget,
  accounts: AccountsClient,
): Promise<PushIdentity | null> {
  if (target.kind === 'here') return null;
  const client: AuthClient | null = accounts.clientOf(target.userId);
  if (!client) return null;
  let s = await client.current();
  if (!s) return null;
  if (s.organizationId !== target.orgId)
    s = await client.switchOrganization(target.orgId);
  const accessToken = await client.accessToken();
  return accessToken ? { accessToken, organizationId: target.orgId } : null;
}

/** Runs as the account and org that have the space, before opening it. */
async function switchFor(
  target: PushTarget,
  accounts: AccountsClient,
): Promise<void> {
  if (target.kind === 'here') return;
  const account = accounts.accounts().find((a) => a.userId === target.userId);
  const org = account?.orgs.find((o) => o.id === target.orgId)?.name;
  setSwitching(org || account?.label || null);
  try {
    await accounts.switchTo(target.userId, target.orgId);
  } catch (e) {
    setSwitching(null);
    console.warn('push: could not switch to the account of the space', e);
  }
}

async function handle(
  response: Notifications.NotificationResponse,
  services: PushServices,
  navigate: (path: string) => void,
): Promise<void> {
  const { fleet, accounts } = services;
  const { notification, actionIdentifier, userText } = response;
  const key = responseKey(notification.request.identifier, actionIdentifier);
  if (handled.has(key)) return;
  handled.add(key);

  const data = notification.request.content.data;
  const action = classifyResponse({ actionIdentifier, userText, data });
  if (action.type === 'ignore') return;
  if (action.type === 'open') {
    // Another account's space: that account first (docs/mobile.md
    // "Several accounts"), then the space.
    await switchFor(await targetOf(action.space, services), accounts);
    navigate(spacePath(action.space));
    return;
  }
  if (action.type === 'home') {
    navigate(HOME_PATH);
    return;
  }
  try {
    if (action.type === 'confirm') {
      // No space in a confirm: it is answered as the active account.
      await fleet.confirmOverHttp(
        action.hostDevice,
        action.confirmId,
        action.allow,
      );
    } else {
      const as = await identityFor(
        await targetOf(action.space, services),
        accounts,
      );
      await fleet.answerOverHttp(
        action.space,
        action.askId,
        action.answers,
        action.hostDevice,
        as,
      );
    }
    await Notifications.dismissNotificationAsync(
      notification.request.identifier,
    );
  } catch (e) {
    console.warn('push: answering from the notification failed', e);
    // Never lose the question silently: a local notification that opens it
    // (a confirm's opens Home, where it waits).
    await Notifications.scheduleNotificationAsync({
      content: {
        title: notification.request.content.title ?? 'Theodore Code',
        body: "Couldn't send your answer. Tap to answer in the app.",
        data: { ...data, options: [] },
      },
      trigger: null,
    });
  }
}

/**
 * Wires notification taps and actions. Call once the clients exist (root
 * layout). Also replays the response that launched the app from a killed
 * state. Returns an unsubscribe.
 */
export function handleNotificationResponses(
  services: PushServices,
  navigate: (path: string) => void,
): () => void {
  if (Platform.OS === 'web') return () => {};
  const sub = Notifications.addNotificationResponseReceivedListener((r) => {
    void handle(r, services, navigate);
  });
  void Notifications.getLastNotificationResponseAsync().then((r) => {
    if (r) void handle(r, services, navigate);
  });
  return () => sub.remove();
}
