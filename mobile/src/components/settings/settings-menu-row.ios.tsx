/**
 * iOS: the row is a SwiftUI `Menu` whose label is drawn like
 * `SettingsRow` (20 pt symbol, 17 pt label, the choice in secondary and
 * ⌃⌄); the menu holds an inline `Picker`, a check on the current choice.
 *
 * ```text
 * [◐]  Appearance                System ⌃⌄   ─▶   Light
 *                                                 Dark
 *                                                 System ✓
 * ```
 */
import {
  HStack,
  Host,
  Image,
  Menu,
  Picker,
  Spacer,
  Text,
} from '@expo/ui/swift-ui';
import {
  accessibilityLabel as a11yLabel,
  buttonStyle,
  contentShape,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  menuIndicator,
  menuStyle,
  padding,
  pickerStyle,
  shapes,
  tag,
} from '@expo/ui/swift-ui/modifiers';
import { useHostTheme } from '../../ui/native/host.ios';
import { usePalette } from '../../ui/theme';
import { SYMBOLS } from '../symbol-image';
import { tick } from './feedback';
import type { SettingsMenuRowProps } from './types';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

export function SettingsMenuRow<T extends string>({
  icon,
  label,
  choices,
  value,
  onChange,
  testID,
}: SettingsMenuRowProps<T>) {
  const p = usePalette();
  const theme = useHostTheme();
  const shown = choices.find((c) => c.value === value)?.label ?? '';
  return (
    <Host
      {...theme}
      matchContents={{ vertical: true }}
      ignoreSafeArea="container"
      style={{ width: '100%' }}
    >
      <Menu
        label={
          <HStack
            spacing={16}
            modifiers={[
              padding({ horizontal: 20, vertical: 14 }),
              frame({ maxWidth: Infinity }),
              contentShape(shapes.rectangle()),
            ]}
          >
            <Image
              systemName={SYMBOLS[icon].sf}
              size={20}
              color={p.text}
              modifiers={[frame({ width: 20 })]}
            />
            <Text
              modifiers={[
                font({ size: 17 }),
                foregroundStyle(p.text),
                lineLimit(1),
              ]}
            >
              {label}
            </Text>
            <Spacer />
            <HStack spacing={4}>
              <Text modifiers={[font({ size: 15 }), secondary]}>{shown}</Text>
              <Image
                systemName="chevron.up.chevron.down"
                size={12}
                modifiers={[secondary]}
              />
            </HStack>
          </HStack>
        }
        testID={testID}
        modifiers={[
          menuStyle('button'),
          buttonStyle('plain'),
          menuIndicator('hidden'),
          a11yLabel(`${label}, ${shown}`),
        ]}
      >
        <Picker<string>
          label={label}
          selection={value}
          onSelectionChange={(v) => {
            const c = choices.find((x) => x.value === v);
            if (!c || c.value === value) return;
            tick();
            onChange(c.value);
          }}
          modifiers={[pickerStyle('inline')]}
        >
          {choices.map((c) => (
            <Text
              key={c.value}
              modifiers={[
                tag(c.value),
                ...(c.accessibilityLabel
                  ? [a11yLabel(c.accessibilityLabel)]
                  : []),
              ]}
            >
              {c.label}
            </Text>
          ))}
        </Picker>
      </Menu>
    </Host>
  );
}
