/**
 * "Help improve Theodore": the sharing choice, asked once after sign-in on
 * Home (docs/telemetry.md "The choice"), the desktop's onboarding step as
 * a card. It shows only while a sink can send and no choice is recorded;
 * until then nothing is sent or queued. Settings → Privacy changes it.
 *
 * ```text
 * ╭──────────────────────────────────────────────╮
 * │ Help improve Theodore                        │
 * │ (●) Share usage data                         │
 * │     Which features are used, counts…         │
 * │ (●) Send error reports                       │
 * │     Warnings, errors and crash reports…      │
 * │ What's collected ›                           │  ─▶ /settings/collected
 * │            ( Don't share )  (    Save    )   │
 * ╰──────────────────────────────────────────────╯
 * ```
 */
import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuthState } from '../shell/AppProviders';
import { useConsent } from '../telemetry/consent';
import { telemetry, track } from '../telemetry/log';
import { Button, Glass, Switch, liquidGlass } from './native';
import {
  SHARE_ROWS,
  SHARE_TITLE,
  WHATS_COLLECTED,
  cardChoice,
  needsSharingChoice,
} from './privacy';
import { usePalette } from './theme';

export function SharingCard() {
  const p = usePalette();
  const { session, demo } = useAuthState();
  const { choice, loaded } = useConsent();
  const [picked, setPicked] = useState({ usage: true, errors: true });
  const [saving, setSaving] = useState(false);
  const status = telemetry.status();
  const available = {
    usage: status.usageAvailable,
    errors: status.errorsAvailable,
  };
  // Signed in to a real account: linking means an account to link.
  if (!session || demo || !needsSharingChoice(choice, available, loaded))
    return null;

  const save = (c: { usage: boolean; errors: boolean }) => {
    setSaving(true);
    void telemetry
      .setChoice(c)
      .then(() => track('consent_changed', { ...c, where: 'card' }))
      .finally(() => setSaving(false));
  };

  return (
    <View style={styles.wrap} testID="sharing-card">
      <Glass
        radius={20}
        tint={liquidGlass ? `${p.accent}20` : undefined}
        style={styles.card}
      >
        <Text
          accessibilityRole="header"
          style={[styles.title, { color: p.text }]}
        >
          {SHARE_TITLE}
        </Text>
        {SHARE_ROWS.map((row) => (
          <Switch
            key={row.kind}
            label={row.label}
            detail={
              available[row.kind] ? row.hint : 'Not configured in this build'
            }
            value={available[row.kind] && picked[row.kind]}
            disabled={!available[row.kind] || saving}
            onValueChange={(v) => setPicked((s) => ({ ...s, [row.kind]: v }))}
            testID={`sharing-${row.kind}`}
          />
        ))}
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push('/settings/collected' as Href)}
          style={styles.link}
          testID="sharing-collected"
        >
          <Text style={[styles.linkText, { color: p.accent }]}>
            {WHATS_COLLECTED} ›
          </Text>
        </Pressable>
        <View style={styles.actions}>
          <Button
            label="Don't share"
            variant="plain"
            pill
            disabled={saving}
            onPress={() => save({ usage: false, errors: false })}
          />
          <Button
            label="Save"
            variant={liquidGlass ? 'glassProminent' : 'primary'}
            pill
            loading={saving}
            onPress={() => save(cardChoice(picked, available))}
          />
        </View>
      </Glass>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 16, paddingTop: 8 },
  card: { padding: 14, gap: 6 },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 2 },
  link: { paddingVertical: 6 },
  linkText: { fontSize: 14, fontWeight: '500' },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
});
