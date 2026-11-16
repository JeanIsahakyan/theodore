/**
 * Settings → About: this app's version and the Theodore cloud it talks
 * to (both selectable, for a bug report).
 */
import Constants from 'expo-constants';
import { SettingsRow, SettingsScroll } from '../../../src/components/settings';
import { config } from '../../../src/config';
import { serverHost } from '../../../src/ui/settingsView';

export default function AboutScreen() {
  return (
    <SettingsScroll testID="settings-about-page">
      <SettingsRow
        icon="info"
        label="Version"
        detail={Constants.expoConfig?.version ?? '—'}
        selectable
      />
      <SettingsRow
        icon="server"
        label="Server"
        detail={serverHost(config.cloudUrl)}
        selectable
      />
    </SettingsScroll>
  );
}
