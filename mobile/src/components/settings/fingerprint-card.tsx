/**
 * This device's fingerprint, to show on a computer so it can trust this
 * device: Devices' hero card and Settings → This device.
 *
 * ```text
 * ╭──────────────────────────────────────╮
 * │ [▯]  Jean's iPhone       ● Connected │
 * │                                      │
 * │ FINGERPRINT                          │
 * │ 1a2b 3c4d 5e6f 7a8b                  │   large, monospace, selectable
 * │ 9c0d 1e2f 3a4b 5c6d                  │
 * │ ( ⧉ Copy )                           │   ─▶ clipboard ─▶ "Copied" (2 s)
 * │ Show this on your computer to trust  │
 * │ this device.                         │
 * ╰──────────────────────────────────────╯
 * ```
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { ConnectionState } from '../../fleet/types';
import {
  CONNECTION_LABEL,
  fingerprintLabel,
  fingerprintLines,
} from '../../ui/deviceView';
import { mono, usePalette } from '../../ui/theme';
import { SymbolImage, type SymbolName } from '../symbol-image';
import { copied, copyText } from './feedback';

const android = process.env.EXPO_OS === 'android';

const STATUS_CLASS: Record<ConnectionState, string> = {
  connected: 'bg-success/15',
  connecting: 'bg-warning/15',
  error: 'bg-danger/15',
  off: 'bg-background',
};

const STATUS_TEXT: Record<ConnectionState, string> = {
  connected: 'text-success',
  connecting: 'text-warning',
  error: 'text-danger',
  off: 'text-muted-foreground',
};

/** This device's link to the cloud as a small pill. */
export function ConnectionPill({ state }: { state: ConnectionState }) {
  return (
    <View
      className={`flex-row items-center gap-1.5 rounded-full px-2.5 py-1 ${STATUS_CLASS[state]}`}
    >
      <View
        className={`h-1.5 w-1.5 rounded-full ${state === 'connected' ? 'bg-success' : state === 'connecting' ? 'bg-warning' : state === 'error' ? 'bg-danger' : 'bg-muted-foreground'}`}
      />
      <Text className={`text-xs font-medium ${STATUS_TEXT[state]}`}>
        {CONNECTION_LABEL[state]}
      </Text>
    </View>
  );
}

function CopyButton({ value }: { value: string }) {
  const p = usePalette();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    if (!value || !(await copyText(value))) return;
    copied();
    setDone(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 2000);
  };
  return (
    <Pressable
      onPress={() => void copy()}
      disabled={!value}
      accessibilityRole="button"
      accessibilityLabel={done ? 'Fingerprint copied' : 'Copy fingerprint'}
      testID="fingerprint-copy"
      android_ripple={{ color: p.border }}
      className={
        android
          ? 'h-10 flex-row items-center gap-2 self-start overflow-hidden rounded-full bg-secondary px-5'
          : 'h-9 flex-row items-center gap-1.5 self-start rounded-full bg-background px-4 active:opacity-60'
      }
    >
      <SymbolImage
        name={done ? 'check' : 'copy'}
        size={android ? 18 : 15}
        color={done ? p.success : p.text}
      />
      <Text
        className={`text-sm font-medium ${done ? 'text-success' : 'text-foreground'}`}
      >
        {done ? 'Copied' : 'Copy'}
      </Text>
    </Pressable>
  );
}

export function FingerprintCard({
  name,
  icon,
  connection,
  value,
  hint,
}: {
  name: string;
  icon: SymbolName;
  connection: ConnectionState;
  value: string;
  hint: string;
}) {
  const p = usePalette();
  const lines = fingerprintLines(value);
  return (
    <View
      testID="this-device"
      className={
        android
          ? 'mx-4 mt-2 gap-4 rounded-3xl bg-muted p-5'
          : 'mx-5 mt-4 gap-4 rounded-2xl bg-muted p-5'
      }
      style={{ borderCurve: 'continuous' }}
    >
      <View className="flex-row items-center gap-3">
        <View className="h-11 w-11 items-center justify-center rounded-xl bg-primary/15">
          <SymbolImage name={icon} size={22} color={p.accent} />
        </View>
        <Text
          numberOfLines={1}
          className="flex-1 text-[17px] font-semibold text-foreground"
        >
          {name}
        </Text>
        <ConnectionPill state={connection} />
      </View>
      <View className="gap-1.5">
        <Text className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          Fingerprint
        </Text>
        <Text
          selectable
          accessibilityLabel={fingerprintLabel(value)}
          className="text-[22px] leading-8 text-foreground"
          style={mono}
        >
          {lines.length ? lines.join('\n') : '—'}
        </Text>
      </View>
      <CopyButton value={value} />
      <Text className="text-[13px] leading-snug text-muted-foreground">
        {hint}
      </Text>
    </View>
  );
}
