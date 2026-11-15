/** iOS: SwiftUI `ProgressView` (circular spinner or linear bar). */
import { ProgressView } from '@expo/ui/swift-ui';
import {
  accessibilityLabel as a11yLabel,
  progressViewStyle,
} from '@expo/ui/swift-ui/modifiers';
import { ControlHost } from './host.ios';
import type { ProgressProps } from './types';

export function Progress({
  value,
  variant = 'circular',
  accessibilityLabel,
  testID,
  style,
}: ProgressProps) {
  return (
    <ControlHost
      style={style}
      width={variant === 'linear' ? 'fill' : 'content'}
    >
      <ProgressView
        value={value ?? undefined}
        testID={testID}
        modifiers={[
          progressViewStyle(variant),
          ...(accessibilityLabel ? [a11yLabel(accessibilityLabel)] : []),
        ]}
      />
    </ControlHost>
  );
}
