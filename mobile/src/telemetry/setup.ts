/**
 * Wires the app's telemetry once (`AppProviders`): the platform's data
 * storage (files on native, IndexedDB on web: `src/fleet/data.ts`), the
 * build facts every remote record carries, the sinks from the build-time
 * config, and the global error handlers.
 *
 * ```text
 * EXPO_PUBLIC_THEODORE_POSTHOG_KEY / _HOST   empty key ─▶ no usage sink
 * EXPO_PUBLIC_CLOUD_URL                      the relay for error reports
 * EXPO_PUBLIC_THEODORE_GIT_SHA               the commit, when CI passes it
 * EXPO_PUBLIC_THEODORE_BUILD_ENV             production | staging; else from
 *                                            the cloud URL (…-staging) or dev
 * ```
 */
import { randomUUID } from '../fleet/random';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { config } from '../config';
import { createDataStorage } from '../fleet/data';
import type { AuthClient } from '../auth/types';
import { installErrorHandlers } from './errors';
import { telemetry } from './log';
import type { AppFacts, TelemetryRecord } from './types';

const web = Platform.OS === 'web';

function webOs(): { os: string; version: string } {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const pick = (os: string, re: RegExp) => {
    const m = re.exec(ua);
    return { os, version: m?.[1]?.replace(/_/g, '.') ?? 'unknown' };
  };
  if (/iPhone|iPad/.test(ua)) return pick('ios', /OS (\d+[_.]\d+(?:[_.]\d+)?)/);
  if (/Mac/.test(ua)) return pick('macos', /Mac OS X (\d+[_.]\d+(?:[_.]\d+)?)/);
  if (/Windows/.test(ua)) return pick('windows', /Windows NT (\d+\.\d+)/);
  if (/Android/.test(ua)) return pick('android', /Android (\d+(?:\.\d+)*)/);
  return { os: 'linux', version: 'unknown' };
}

export function buildEnv(cloudUrl: string): string {
  const env = process.env.EXPO_PUBLIC_THEODORE_BUILD_ENV;
  if (env === 'production' || env === 'staging') return env;
  if (__DEV__) return 'dev';
  return /staging/.test(cloudUrl) ? 'staging' : 'production';
}

/** The facts of this build and device. */
export function appFacts(): AppFacts {
  const w = web ? webOs() : null;
  return {
    app_version: Constants.expoConfig?.version ?? '0.0.0',
    channel: __DEV__ ? 'dev' : web ? 'web' : 'store',
    platform: web ? 'web' : Platform.OS,
    os: w ? w.os : Platform.OS,
    os_version: w ? w.version : (Device.osVersion ?? 'unknown'),
    build: process.env.EXPO_PUBLIC_THEODORE_GIT_SHA?.slice(0, 12) || 'unknown',
    build_env: buildEnv(config.cloudUrl),
  };
}

/** The PostHog sink from the build-time config; `null` without a key. */
export function posthogConfig(): { host: string; key: string } | null {
  const key = process.env.EXPO_PUBLIC_THEODORE_POSTHOG_KEY?.trim() ?? '';
  if (!key) return null;
  const host =
    process.env.EXPO_PUBLIC_THEODORE_POSTHOG_HOST?.trim() ||
    'https://us.i.posthog.com';
  return { host, key };
}

const mirror = (r: TelemetryRecord) => {
  const line = `[${r.level}] ${r.msg}`;
  const fields = Object.keys(r.fields).length ? r.fields : undefined;
  if (r.level === 'error') console.error(line, fields ?? '');
  else if (r.level === 'warn') console.warn(line, fields ?? '');
  else console.log(line, fields ?? '');
};

let started = false;

/** Once per JS runtime, before anything else logs with a sink in mind. */
export function startTelemetry(auth: AuthClient): Promise<void> {
  if (started) return telemetry.whenReady();
  started = true;
  installErrorHandlers();
  return telemetry.configure({
    storage: createDataStorage(),
    facts: appFacts(),
    randomUUID: () => randomUUID(),
    fetch: (...a) => fetch(...a),
    posthog: posthogConfig(),
    cloudUrl: config.cloudUrl,
    token: () => auth.accessToken().catch(() => null),
    minLevel: __DEV__ ? 'debug' : 'info',
    mirror: __DEV__ ? mirror : undefined,
  });
}
