/**
 * Settings → About: this app's version and the Theodore cloud it talks
 * to (both selectable, for a bug report), the privacy policy, and the
 * local log for a problem report (docs/telemetry.md "Mobile"):
 *
 * ```text
 * Copy diagnostics   ─▶ the redacted log on the clipboard ("Copied")
 * Share diagnostics  ─▶ the system share sheet (native only)
 * ```
 */
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Platform, Share } from 'react-native';
import {
  SectionDivider,
  SectionNote,
  SettingsRow,
  SettingsScroll,
  copyText,
} from '../../../src/components/settings';
import { copied } from '../../../src/components/settings/feedback';
import { config } from '../../../src/config';
import { diagnosticsText, recordCount } from '../../../src/telemetry/export';
import { telemetry, track } from '../../../src/telemetry/log';
import { appFacts } from '../../../src/telemetry/setup';
import { serverHost } from '../../../src/ui/settingsView';

const native = Platform.OS !== 'web';

export default function AboutScreen() {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<'copy' | 'share' | null>(null);

  const diagnostics = () => {
    const log = telemetry.exportText();
    return {
      text: diagnosticsText({
        facts: appFacts(),
        installId: telemetry.status().installId,
        log,
      }),
      records: recordCount(log),
    };
  };

  const copy = async () => {
    setBusy('copy');
    const d = diagnostics();
    const ok = await copyText(d.text);
    if (ok) copied();
    setNote(
      ok
        ? `Copied ${d.records} log records. Paste them into your report.`
        : "Couldn't copy on this device.",
    );
    track('diagnostics_exported', { how: 'copy', records: d.records });
    setBusy(null);
  };

  const share = async () => {
    setBusy('share');
    const d = diagnostics();
    try {
      await Share.share({ message: d.text, title: 'Theodore diagnostics' });
      track('diagnostics_exported', { how: 'share', records: d.records });
    } catch {
      setNote("Couldn't open the share sheet.");
    }
    setBusy(null);
  };

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
      <SettingsRow
        icon="globe"
        label="Privacy policy"
        onPress={() =>
          void WebBrowser.openBrowserAsync(config.privacyPolicyUrl).catch(
            () => {},
          )
        }
        testID="settings-privacy"
      />

      <SectionDivider />

      <SettingsRow
        icon="copy"
        label="Copy diagnostics"
        subtitle="The local log, redacted on this device, for a problem report."
        loading={busy === 'copy'}
        onPress={() => void copy()}
        testID="settings-copy-diagnostics"
      />
      {native ? (
        <SettingsRow
          icon="share"
          label="Share diagnostics"
          loading={busy === 'share'}
          onPress={() => void share()}
          testID="settings-share-diagnostics"
        />
      ) : null}
      {note ? <SectionNote>{note}</SectionNote> : null}
    </SettingsScroll>
  );
}
