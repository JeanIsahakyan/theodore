// Adapted from EvanBacon/chat-template (MIT)
/**
 * Devices: this device's fingerprint first (to show on your computer so it
 * can trust this device), then a card per device with trust / untrust
 * (docs/mobile.md "Settings and Devices").
 *
 * ```text
 * [connection banner, when not connected]
 * ╭ This device ─────────────── ● Connected ╮   FingerprintCard: large, Copy,
 * │ 1a2b 3c4d 5e6f 7a8b / 9c0d …            │   "Show this on your computer…"
 * ╰─────────────────────────────────────────╯
 * Computers                    2 of 3 online   online first, then by name
 *   DeviceCard  [kind] name ● Online / line / fingerprint / Trust | Untrust
 * Phones and browsers                  online
 *   DeviceCard …
 * (none) ─▶ "No other devices yet" + how to add one
 * ```
 */
import { useMemo } from 'react';
import { Text, View } from 'react-native';
import {
  DeviceCard,
  FingerprintCard,
  SectionHeader,
  SettingsScroll,
  kindSymbol,
} from '../../src/components/settings';
import { SymbolImage } from '../../src/components/symbol-image';
import { useFleetState } from '../../src/state/fleet';
import { ConnectionBanner } from '../../src/ui/ConnectionBanner';
import { groupDevices, groupOnline } from '../../src/ui/deviceView';
import { usePalette } from '../../src/ui/theme';

const android = process.env.EXPO_OS === 'android';

function NoDevices() {
  const p = usePalette();
  return (
    <View
      className={`${android ? 'mx-4 rounded-3xl' : 'mx-5 rounded-2xl'} mt-2 items-center gap-2 border border-dashed border-border px-6 py-10`}
      style={{ borderCurve: 'continuous' }}
    >
      <View className="mb-1 h-12 w-12 items-center justify-center rounded-full bg-muted">
        <SymbolImage name="devices" size={24} color={p.muted} />
      </View>
      <Text className="text-[17px] font-semibold text-foreground">
        No other devices yet
      </Text>
      <Text className="text-center text-[15px] leading-snug text-muted-foreground">
        Open Theodore on a computer signed in to the same account. It shows up
        here to trust.
      </Text>
    </View>
  );
}

export default function DevicesScreen() {
  const fingerprint = useFleetState((s) => s.fingerprint);
  const connection = useFleetState((s) => s.connection);
  const allDevices = useFleetState((s) => s.devices);
  const me = useMemo(() => allDevices.find((d) => d.thisDevice), [allDevices]);
  const groups = useMemo(
    () => groupDevices(allDevices.filter((d) => !d.thisDevice)),
    [allDevices],
  );

  return (
    <SettingsScroll testID="devices">
      <ConnectionBanner style={{ marginTop: 12 }} />
      <FingerprintCard
        name={me?.name || 'This device'}
        icon={kindSymbol(me?.kind ?? 'mobile')}
        connection={connection}
        value={fingerprint}
        hint="Show this on your computer to trust this device."
      />

      {groups.length === 0 ? (
        <>
          <SectionHeader title="Your devices" />
          <NoDevices />
        </>
      ) : (
        groups.map((g) => (
          <View key={g.key}>
            <SectionHeader title={g.title} trailing={groupOnline(g.devices)} />
            {g.devices.map((d) => (
              <DeviceCard key={d.deviceId} device={d} />
            ))}
          </View>
        ))
      )}
    </SettingsScroll>
  );
}
