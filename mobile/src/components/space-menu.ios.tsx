/**
 * iOS: the row is the trigger of a SwiftUI `ContextMenu` (UIKit's context
 * menu interaction: a long press lifts the row, the system's haptic, the
 * menu under it). The React Native row is hosted in the SwiftUI tree as it
 * is; each item a `Button`, Archive with the `destructive` role.
 *
 * ```text
 *   Fix the login redirect   ●    ── long press ──▶  ╭ Archive        ⌸ ╮
 * ```
 */
import { Button, ContextMenu, Host, RNHostView } from '@expo/ui/swift-ui';
import { View } from 'react-native';
import { useHostTheme } from '../ui/native/host.ios';
import type { SpaceMenuProps } from './space-menu-types';
import { SYMBOLS } from './symbol-image';

const NO_SLOTS = {};

export function SpaceMenu({
  items,
  onSelect,
  testID,
  children,
}: SpaceMenuProps) {
  const theme = useHostTheme();
  if (items.length === 0) return <>{children(NO_SLOTS)}</>;
  return (
    <Host
      {...theme}
      matchContents={{ vertical: true }}
      ignoreSafeArea="container"
      style={{ width: '100%' }}
      testID={testID}
    >
      <ContextMenu>
        <ContextMenu.Trigger>
          <RNHostView matchContents={{ vertical: true }}>
            <View>{children(NO_SLOTS)}</View>
          </RNHostView>
        </ContextMenu.Trigger>
        <ContextMenu.Items>
          {items.map((item) => (
            <Button
              key={item.id}
              label={item.label}
              systemImage={SYMBOLS[item.icon].sf}
              role={item.destructive ? 'destructive' : 'default'}
              onPress={() => onSelect(item.id)}
            />
          ))}
        </ContextMenu.Items>
      </ContextMenu>
    </Host>
  );
}
