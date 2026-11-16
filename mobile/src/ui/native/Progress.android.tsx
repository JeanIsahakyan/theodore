/** Android: Material 3 `CircularProgressIndicator` / `LinearProgressIndicator`. */
import {
  CircularProgressIndicator,
  LinearProgressIndicator,
} from '@expo/ui/jetpack-compose';
import {
  fillMaxWidth,
  semantics,
  size,
  testID as testIDMod,
  type ModifierConfig,
} from '@expo/ui/jetpack-compose/modifiers';
import { usePalette } from '../theme';
import { ControlHost } from './host.android';
import type { ProgressProps } from './types';

export function Progress({
  value,
  variant = 'circular',
  accessibilityLabel,
  testID,
  style,
}: ProgressProps) {
  const p = usePalette();
  const mods: ModifierConfig[] = [];
  if (accessibilityLabel)
    mods.push(semantics({ contentDescription: accessibilityLabel }));
  if (testID) mods.push(testIDMod(testID));
  return (
    <ControlHost
      style={style}
      width={variant === 'linear' ? 'fill' : 'content'}
    >
      {variant === 'linear' ? (
        <LinearProgressIndicator
          progress={value ?? null}
          color={p.accent}
          modifiers={[fillMaxWidth(), ...mods]}
        />
      ) : (
        <CircularProgressIndicator
          progress={value ?? null}
          color={p.accent}
          strokeWidth={3}
          modifiers={[size(28, 28), ...mods]}
        />
      )}
    </ControlHost>
  );
}
