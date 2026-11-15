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
import type { FleetClient } from '../fleet/types';
import {
  ACTION_OPEN,
  ACTION_REPLY,
  CATEGORY_TEXT,
  classifyResponse,
  optionAction,
  optionCategory,
  responseKey,
  showInForeground,
  spacePath,
} from './contract';

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
 * Asks for permission, gets the Expo push token and hands it to the cloud.
 * A no-op (never throws) on web, on simulators/emulators (no push token
 * there), when the user turned notifications off, when permission is denied,
 * when the build has no EAS `projectId`, or when the token request fails
 * (offline: it runs again at the next start).
 */
export async function registerForPush(fleet: FleetClient): Promise<void> {
  if (Platform.OS === 'web' || !Device.isDevice) return;
  if (!(await getNotificationsEnabled())) return;
  try {
    // Android 13+ shows the permission prompt only once a channel exists.
    await ensureChannel();
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) {
      perm = await Notifications.requestPermissionsAsync();
    }
    if (!perm.granted) return;
    const projectId: string | undefined =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;
    if (!projectId) {
      console.warn('push: no EAS projectId in app config; not registering');
      return;
    }
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    await fleet.registerPush(token.data);
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

async function handle(
  response: Notifications.NotificationResponse,
  fleet: FleetClient,
  navigate: (path: string) => void,
): Promise<void> {
  const { notification, actionIdentifier, userText } = response;
  const key = responseKey(notification.request.identifier, actionIdentifier);
  if (handled.has(key)) return;
  handled.add(key);

  const data = notification.request.content.data;
  const action = classifyResponse({ actionIdentifier, userText, data });
  if (action.type === 'ignore') return;
  if (action.type === 'open') {
    navigate(spacePath(action.space));
    return;
  }
  try {
    await fleet.answerOverHttp(
      action.space,
      action.askId,
      action.answers,
      action.hostDevice,
    );
    await Notifications.dismissNotificationAsync(
      notification.request.identifier,
    );
  } catch (e) {
    console.warn('push: answering from the notification failed', e);
    // Never lose the question silently: a local notification that opens it.
    await Notifications.scheduleNotificationAsync({
      content: {
        title: notification.request.content.title ?? 'Theodore',
        body: "Couldn't send your answer. Tap to answer in the app.",
        data: { ...data, options: [] },
      },
      trigger: null,
    });
  }
}

/**
 * Wires notification taps and actions. Call once the fleet client exists
 * (root layout). Also replays the response that launched the app from a killed
 * state. Returns an unsubscribe.
 */
export function handleNotificationResponses(
  fleet: FleetClient,
  navigate: (path: string) => void,
): () => void {
  if (Platform.OS === 'web') return () => {};
  const sub = Notifications.addNotificationResponseReceivedListener((r) => {
    void handle(r, fleet, navigate);
  });
  void Notifications.getLastNotificationResponseAsync().then((r) => {
    if (r) void handle(r, fleet, navigate);
  });
  return () => sub.remove();
}
