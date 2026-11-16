/**
 * Settings → This device: its name, its link to the cloud, and its
 * fingerprint large (copy it, or read it out) to compare on the computer
 * before trusting this device there.
 */
import {
  FingerprintCard,
  SettingsScroll,
  kindSymbol,
} from '../../../src/components/settings';
import { useFleetState } from '../../../src/state/fleet';

export default function ThisDeviceScreen() {
  const fingerprint = useFleetState((s) => s.fingerprint);
  const connection = useFleetState((s) => s.connection);
  const me = useFleetState((s) => s.devices.find((d) => d.thisDevice));
  return (
    <SettingsScroll testID="settings-device">
      <FingerprintCard
        name={me?.name || 'This device'}
        icon={kindSymbol(me?.kind ?? 'mobile')}
        connection={connection}
        value={fingerprint}
        hint="Compare the fingerprint with the one your computer shows before you trust this device there."
      />
    </SettingsScroll>
  );
}
