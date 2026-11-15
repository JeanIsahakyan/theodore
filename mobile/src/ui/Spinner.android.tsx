/** Android: a 16 dp Material 3 `CircularProgressIndicator` for a row. */
import { CircularProgressIndicator } from '@expo/ui/jetpack-compose';
import { size } from '@expo/ui/jetpack-compose/modifiers';
import { ControlHost } from './native/host.android';

export function Spinner({ color }: { color: string }) {
  return (
    <ControlHost>
      <CircularProgressIndicator
        color={color}
        strokeWidth={2}
        modifiers={[size(16, 16)]}
      />
    </ControlHost>
  );
}
