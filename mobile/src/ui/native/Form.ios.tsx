/**
 * iOS: a SwiftUI `Form` (inset grouped, scrolls itself) in a `Host` that
 * fills the screen; `Section` ─▶ `Section`, `Row` ─▶ a row `Button` (or a
 * plain row), `FormSlot` ─▶ `RNHostView`.
 */
import {
  Button as SButton,
  Form as SForm,
  HStack,
  Host,
  Image,
  ProgressView,
  RNHostView,
  Section as SSection,
  Spacer,
  Text,
  VStack,
} from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityLabel as a11yLabel,
  disabled as disabledMod,
  font,
  foregroundStyle,
  imageScale,
  textSelection,
  type ModifierConfig,
} from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';
import { usePalette } from '../theme';
import { InForm } from './context';
import { useHostTheme } from './host.ios';
import type { FormProps, FormSlotProps, RowProps, SectionProps } from './types';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
const tertiary = foregroundStyle({ type: 'hierarchical', style: 'tertiary' });

export function Form({ children, testID }: FormProps) {
  const theme = useHostTheme();
  return (
    <Host {...theme} useViewportSizeMeasurement style={{ flex: 1 }}>
      <SForm testID={testID}>
        <InForm.Provider value>{children}</InForm.Provider>
      </SForm>
    </Host>
  );
}

export function Section({ title, footer, children }: SectionProps) {
  return (
    <SSection title={title} footer={footer ? <Text>{footer}</Text> : undefined}>
      {children}
    </SSection>
  );
}

export function Row({
  label,
  detail,
  value,
  onPress,
  chevron,
  selected,
  destructive,
  loading,
  disabled,
  accessibilityLabel,
  testID,
}: RowProps) {
  const p = usePalette();
  const labelText = (
    <Text
      modifiers={[
        destructive
          ? foregroundStyle(p.danger)
          : foregroundStyle({ type: 'hierarchical', style: 'primary' }),
      ]}
    >
      {label}
    </Text>
  );
  const content = (
    <HStack spacing={12}>
      {detail ? (
        <VStack alignment="leading" spacing={2}>
          {labelText}
          <Text modifiers={[font({ textStyle: 'footnote' }), secondary]}>
            {detail}
          </Text>
        </VStack>
      ) : (
        labelText
      )}
      <Spacer />
      {value != null ? (
        <Text
          modifiers={[secondary, ...(onPress ? [] : [textSelection(true)])]}
        >
          {value}
        </Text>
      ) : null}
      {loading ? (
        <ProgressView />
      ) : selected ? (
        <Image systemName="checkmark" color={p.accent} />
      ) : chevron ? (
        <Image
          systemName="chevron.right"
          modifiers={[
            imageScale('small'),
            font({ weight: 'semibold' }),
            tertiary,
          ]}
        />
      ) : null}
    </HStack>
  );
  const a11y: ModifierConfig[] = accessibilityLabel
    ? [a11yLabel(accessibilityLabel)]
    : [];
  if (!onPress) {
    return (
      <HStack
        testID={testID}
        modifiers={[accessibilityElement('combine'), ...a11y]}
      >
        {content}
      </HStack>
    );
  }
  return (
    <SButton
      onPress={onPress}
      testID={testID}
      modifiers={[...(disabled || loading ? [disabledMod(true)] : []), ...a11y]}
    >
      {content}
    </SButton>
  );
}

export function FormSlot({ children }: FormSlotProps) {
  return (
    <RNHostView matchContents={{ vertical: true }}>
      <View>
        <InForm.Provider value={false}>{children}</InForm.Provider>
      </View>
    </RNHostView>
  );
}
