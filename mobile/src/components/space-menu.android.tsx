/**
 * Android: the row's long press (a light haptic) opens a Material 3
 * `DropdownMenu` anchored to a hairline under the row (its trigger, which
 * nothing taps): the menu drops below the row at its start. Each item a
 * `DropdownMenuItem` with its glyph; Archive in the danger color.
 *
 * ```text
 *   Fix the login redirect   ●    ── long press ──▶  ╭ ⌸ Archive ╮
 * ```
 */
import {
  Box,
  DropdownMenu,
  DropdownMenuItem,
  Host,
  Icon,
  Text,
} from '@expo/ui/jetpack-compose';
import {
  fillMaxWidth,
  height,
  semantics,
} from '@expo/ui/jetpack-compose/modifiers';
import * as Haptics from 'expo-haptics';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useHostTheme } from '../ui/native/host.android';
import { usePalette } from '../ui/theme';
import type { SpaceMenuItem } from '../ui/spaceMenu';
import type { SpaceMenuProps } from './space-menu-types';

/** Vector drawables of the items (`require` is static). */
const ITEM_ICONS: Partial<Record<SpaceMenuItem['icon'], number>> = {
  archive: require('../../assets/icons/archive.xml'),
};

const NO_SLOTS = {};

export function SpaceMenu({
  title,
  items,
  onSelect,
  testID,
  children,
}: SpaceMenuProps) {
  const p = usePalette();
  const theme = useHostTheme();
  const [open, setOpen] = useState(false);
  const onLongPress = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setOpen(true);
  }, []);
  if (items.length === 0) return <>{children(NO_SLOTS)}</>;
  return (
    <View testID={testID}>
      {children({ onLongPress })}
      <Host {...theme} matchContents={{ vertical: true }} style={styles.anchor}>
        <DropdownMenu
          expanded={open}
          onDismissRequest={() => setOpen(false)}
          modifiers={[fillMaxWidth()]}
        >
          <DropdownMenu.Trigger>
            <Box
              modifiers={[
                fillMaxWidth(),
                height(1),
                semantics({ contentDescription: `${title} options` }),
              ]}
            />
          </DropdownMenu.Trigger>
          <DropdownMenu.Items>
            {items.map((item) => {
              const color = item.destructive ? p.danger : p.text;
              const source = ITEM_ICONS[item.icon];
              return (
                <DropdownMenuItem
                  key={item.id}
                  onClick={() => {
                    setOpen(false);
                    onSelect(item.id);
                  }}
                  modifiers={[semantics({ contentDescription: item.label })]}
                >
                  {source ? (
                    <DropdownMenuItem.LeadingIcon>
                      <Icon source={source} size={24} tint={color} />
                    </DropdownMenuItem.LeadingIcon>
                  ) : null}
                  <DropdownMenuItem.Text>
                    <Text color={color}>{item.label}</Text>
                  </DropdownMenuItem.Text>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenu.Items>
        </DropdownMenu>
      </Host>
    </View>
  );
}

const styles = {
  // The row's margins (mx-3): the menu opens inside the pill's edges.
  anchor: { marginHorizontal: 12 },
};
