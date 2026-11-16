/**
 * iOS: SwiftUI `Button`. primary ─▶ `.borderedProminent`, secondary ─▶
 * `.bordered`, plain ─▶ `.borderless`, destructive ─▶ `.bordered` with
 * `role: .destructive`, glass / glassProminent ─▶ `.glass` /
 * `.glassProminent` on iOS 26+ (`.bordered` / `.borderedProminent` below:
 * SwiftUI's own fallback is `.automatic`, a bare label). In a `Form`: a row
 * button (accent, or red); `fullWidth`, its label centered (Sign out).
 */
import {
  Button as SButton,
  HStack,
  ProgressView,
  Text,
} from '@expo/ui/swift-ui';
import {
  accessibilityLabel as a11yLabel,
  buttonStyle,
  controlSize,
  disabled as disabledMod,
  frame,
  type ModifierConfig,
} from '@expo/ui/swift-ui/modifiers';
import { useInForm } from './context';
import { liquidGlass } from './liquidGlass';
import { ControlHost } from './host.ios';
import type { ButtonProps } from './types';

const styles = {
  primary: 'borderedProminent',
  secondary: 'bordered',
  plain: 'borderless',
  destructive: 'bordered',
  glass: liquidGlass ? 'glass' : 'bordered',
  glassProminent: liquidGlass ? 'glassProminent' : 'borderedProminent',
} as const;

export function Button({
  label,
  onPress,
  variant = 'secondary',
  disabled,
  loading,
  fullWidth,
  accessibilityLabel,
  testID,
  style,
}: ButtonProps) {
  const inForm = useInForm();
  const mods: ModifierConfig[] = [];
  if (!inForm) {
    mods.push(buttonStyle(styles[variant]));
    if (variant !== 'plain') mods.push(controlSize('large'));
  }
  if (disabled || loading) mods.push(disabledMod(true));
  mods.push(a11yLabel(accessibilityLabel ?? label));
  const wide = fullWidth
    ? [frame({ maxWidth: Infinity, alignment: 'center' })]
    : [];
  return (
    <ControlHost style={style} width={fullWidth ? 'fill' : 'content'}>
      <SButton
        role={variant === 'destructive' ? 'destructive' : 'default'}
        onPress={onPress}
        modifiers={mods}
        testID={testID}
      >
        <HStack spacing={8} modifiers={wide}>
          {loading ? <ProgressView /> : null}
          <Text>{label}</Text>
        </HStack>
      </SButton>
    </ControlHost>
  );
}
