/**
 * Settings → Privacy → What's collected: every usage event with its
 * properties, straight from the catalog (`src/telemetry/catalog.ts`), and
 * what is never sent (docs/telemetry.md "Mobile").
 */
import { StyleSheet, Text, View } from 'react-native';
import {
  SectionHeader,
  SectionNote,
  SettingsScroll,
} from '../../../src/components/settings';
import { NEVER_SENT, catalogRows } from '../../../src/telemetry/catalog';
import { TELEMETRY_CLAIM } from '../../../src/ui/privacy';
import { mono, usePalette } from '../../../src/ui/theme';

const android = process.env.EXPO_OS === 'android';

export default function WhatsCollectedScreen() {
  const p = usePalette();
  const rows = catalogRows();
  return (
    <SettingsScroll testID="settings-collected-page">
      <SectionNote>{TELEMETRY_CLAIM}</SectionNote>
      <SectionHeader title="Usage events" trailing={`${rows.length}`} />
      <View style={[styles.list, android ? styles.listAndroid : null]}>
        {rows.map((e) => (
          <Text key={e.name} selectable style={[styles.event, mono]}>
            <Text style={{ color: p.text }}>{e.name}</Text>
            {e.fields.length ? (
              <Text style={{ color: p.muted }}> {e.fields.join(', ')}</Text>
            ) : null}
          </Text>
        ))}
      </View>
      <SectionHeader title="Never sent" />
      <View style={[styles.list, android ? styles.listAndroid : null]}>
        {NEVER_SENT.map((line) => (
          <Text key={line} style={[styles.never, { color: p.muted }]}>
            {'•'} {line}
          </Text>
        ))}
      </View>
      <SectionNote>
        Error reports also carry warnings and errors from the local log, with
        the same redaction. Everything else stays on this device.
      </SectionNote>
    </SettingsScroll>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 20, gap: 6, paddingBottom: 8 },
  listAndroid: { paddingHorizontal: 16 },
  event: { fontSize: 12, lineHeight: 17 },
  never: { fontSize: 14, lineHeight: 20 },
});
