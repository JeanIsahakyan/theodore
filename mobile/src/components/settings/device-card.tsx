/**
 * One of your devices on the Devices page:
 *
 * ```text
 * ╭──────────────────────────────────────────╮
 * │ [▭]  Studio                   ● Online   │   kind tile, name, pill
 * │      macOS · up to Edit · Claude, Codex  │   deviceLine()
 * │                                          │
 * │ 1a2b 3c4d 5e6f 7a8b 9c0d 1e2f 3a4b 5c6d  │   monospace, small, selectable
 * │ ✓ Trusted                     (Untrust)  │   or: Not trusted   [ Trust ]
 * │ <error, if the last trust / untrust failed>
 * │ Claude via cloud          until 18:00    │   a computer's mcp_auto, one
 * │ [ Off | Auto Edit | Full auto ]          │   McpAutoControl per entry
 * ╰──────────────────────────────────────────╯
 * Trust ─▶ system confirm (fingerprint, what trust allows) ─▶ pinned
 * ```
 *
 * Trust and Untrust are the kit's native buttons (prominent / destructive,
 * quieter), named "Trust <name>" / "Untrust <name>" for screen readers
 * and tests.
 */
import { Text, View } from 'react-native';
import type { FleetDeviceView } from '../../fleet/types';
import {
  deviceLine,
  deviceSummary,
  fingerprintLabel,
  isComputer,
} from '../../ui/deviceView';
import { Button } from '../../ui/native';
import { mono, usePalette } from '../../ui/theme';
import { useTrust } from '../../ui/TrustConfirm';
import { SymbolImage, type SymbolName } from '../symbol-image';
import { McpAutoControl } from './mcp-auto';

const android = process.env.EXPO_OS === 'android';

/** A device kind's symbol (desktop | daemon | mobile | web | mcp). */
export function kindSymbol(kind: string): SymbolName {
  switch (kind) {
    case 'daemon':
      return 'server';
    case 'mobile':
      return 'phone';
    case 'web':
    case 'mcp':
      return 'globe';
    default:
      return 'computer';
  }
}

function OnlinePill({ online }: { online: boolean }) {
  return (
    <View
      className={`flex-row items-center gap-1.5 rounded-full px-2.5 py-1 ${online ? 'bg-success/15' : 'bg-background'}`}
    >
      <View
        className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-success' : 'bg-muted-foreground'}`}
      />
      <Text
        className={`text-xs font-medium ${online ? 'text-success' : 'text-muted-foreground'}`}
      >
        {online ? 'Online' : 'Offline'}
      </Text>
    </View>
  );
}

export function DeviceCard({ device }: { device: FleetDeviceView }) {
  const p = usePalette();
  const { trust, untrust, busy, error } = useTrust(device);
  return (
    <View
      testID={`device-${device.deviceId}`}
      className={
        android
          ? 'mx-4 mb-3 gap-3 rounded-3xl bg-muted p-4'
          : 'mx-5 mb-3 gap-3 rounded-2xl bg-muted p-4'
      }
      style={{ borderCurve: 'continuous' }}
    >
      <View
        accessible
        accessibilityLabel={deviceSummary(device)}
        className="flex-row items-center gap-3"
      >
        <View
          className={`h-11 w-11 items-center justify-center rounded-xl ${device.online ? 'bg-primary/15' : 'bg-background'}`}
        >
          <SymbolImage
            name={kindSymbol(device.kind)}
            size={22}
            color={device.online ? p.accent : p.muted}
          />
        </View>
        <View className="flex-1 gap-0.5">
          <Text
            numberOfLines={1}
            className="text-[17px] font-semibold text-foreground"
          >
            {device.name}
          </Text>
          <Text
            numberOfLines={2}
            className="text-[13px] leading-snug text-muted-foreground"
          >
            {deviceLine(device)}
          </Text>
        </View>
        <OnlinePill online={device.online} />
      </View>

      <Text
        selectable
        accessibilityLabel={fingerprintLabel(device.fingerprint)}
        className="text-[13px] leading-5 text-muted-foreground"
        style={mono}
      >
        {device.fingerprint || '—'}
      </Text>

      <View className="flex-row items-center justify-between gap-3">
        {device.trusted ? (
          <View className="flex-row items-center gap-1.5">
            <SymbolImage name="trusted" size={16} color={p.success} />
            <Text className="text-[15px] font-medium text-success">
              Trusted
            </Text>
          </View>
        ) : (
          <Text className="flex-1 text-[13px] leading-snug text-muted-foreground">
            Not trusted yet
          </Text>
        )}
        {device.trusted ? (
          <Button
            label="Untrust"
            variant="destructive"
            loading={busy}
            accessibilityLabel={`Untrust ${device.name}`}
            onPress={untrust}
          />
        ) : (
          <Button
            label="Trust"
            variant="primary"
            loading={busy}
            accessibilityLabel={`Trust ${device.name}`}
            onPress={() => void trust()}
          />
        )}
      </View>

      {error ? (
        <Text
          accessibilityLiveRegion="polite"
          className="text-[13px] leading-snug text-danger"
        >
          {error}
        </Text>
      ) : null}

      {isComputer(device.kind)
        ? device.mcpAuto.map((m) => (
            <McpAutoControl
              key={m.deviceId}
              host={device.deviceId}
              hostName={device.name}
              entry={m}
              trusted={device.trusted}
            />
          ))
        : null}
    </View>
  );
}
