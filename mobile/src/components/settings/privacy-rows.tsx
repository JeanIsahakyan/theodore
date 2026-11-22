/**
 * Settings → Privacy: the two sharing switches, each independent, and the
 * "What's collected" row (docs/telemetry.md "The choice"). A switch of a
 * sink the build can't send to is off and disabled.
 *
 * ```text
 * ──────────
 * (●) Share usage data        Which features are used, counts…
 * (●) Send error reports      Warnings, errors and crash reports…
 * ▤  What's collected                                        ›
 * ```
 */
import type { Href } from 'expo-router';
import { useConsent } from '../../telemetry/consent';
import { telemetry, track } from '../../telemetry/log';
import {
  NOT_CONFIGURED,
  SHARE_ROWS,
  WHATS_COLLECTED,
  switchValue,
} from '../../ui/privacy';
import { SectionHeader } from './section';
import { SettingsRow } from './settings-row';
import { SettingsToggleRow } from './settings-toggle-row';

export function PrivacyRows() {
  const choice = useConsent((s) => s.choice);
  const status = telemetry.status();
  const available = {
    usage: status.usageAvailable,
    errors: status.errorsAvailable,
  };
  const flip = (kind: 'usage' | 'errors', value: boolean) => {
    void telemetry
      .setChoice({ [kind]: value })
      .then((c) =>
        track('consent_changed', {
          usage: c.usage ?? false,
          errors: c.errors ?? false,
          where: 'settings',
        }),
      );
  };
  return (
    <>
      <SectionHeader title="Privacy" />
      {SHARE_ROWS.map((row) => (
        <SettingsToggleRow
          key={row.kind}
          icon={row.kind === 'usage' ? 'chart' : 'warning'}
          label={row.label}
          subtitle={available[row.kind] ? row.hint : NOT_CONFIGURED}
          value={switchValue(choice, row.kind, available[row.kind])}
          disabled={!available[row.kind]}
          onValueChange={(v) => flip(row.kind, v)}
          testID={`settings-share-${row.kind}`}
        />
      ))}
      <SettingsRow
        icon="list"
        label={WHATS_COLLECTED}
        href={'/settings/collected' as Href}
        testID="settings-collected"
      />
    </>
  );
}
