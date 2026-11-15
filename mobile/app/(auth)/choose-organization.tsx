/**
 * The organization picker for a sign-in that needs one (you're in several).
 * The pick is finished through the cloud; the pending sign-in is single-use,
 * so a failure goes back to "Sign in".
 */
import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useServices } from '../../src/services';
import { useAuthState } from '../../src/shell/AppProviders';
import { Button, Card, Notice } from '../../src/ui/kit';
import { usePalette } from '../../src/ui/theme';

export default function ChooseOrganization() {
  const { auth } = useServices();
  const { choices, setChoices } = useAuthState();
  const p = usePalette();
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const backToSignIn = () => {
    setChoices(null);
    if (router.canGoBack()) router.back();
    else router.replace('/sign-in' as Href);
  };

  const pick = (id: string) => {
    if (picking) return;
    setPicking(id);
    setError(null);
    auth
      .chooseOrganization(id)
      .then((r) => {
        if (r.kind === 'failed') {
          setError(r.message);
          setChoices(null);
        }
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setChoices(null);
      })
      .finally(() => setPicking(null));
  };

  const list = choices ?? [];

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.lead, { color: p.muted }]}>
        Your account is in several organizations. Pick the one to use on this
        device; you can switch later in Settings.
      </Text>
      {list.length > 0 ? (
        <Card style={styles.card}>
          {list.map((o, i) => (
            <Pressable
              key={o.id}
              accessibilityRole="button"
              accessibilityLabel={`Use ${o.name || o.id}`}
              accessibilityState={{
                busy: picking === o.id,
                disabled: !!picking,
              }}
              disabled={!!picking}
              onPress={() => pick(o.id)}
              style={({ pressed }) => [
                styles.row,
                i > 0 && {
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: p.border,
                },
                {
                  opacity:
                    picking && picking !== o.id ? 0.45 : pressed ? 0.6 : 1,
                },
              ]}
            >
              <View style={styles.rowText}>
                <Text style={[styles.name, { color: p.text }]}>
                  {o.name || 'Unnamed organization'}
                </Text>
                {picking === o.id ? (
                  <Text style={{ color: p.muted }}>Signing in…</Text>
                ) : null}
              </View>
              <Text style={{ color: p.muted, fontSize: 20 }}>›</Text>
            </Pressable>
          ))}
        </Card>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {list.length === 0 ? (
        <View style={styles.actions}>
          {!error ? (
            <Notice tone="neutral">
              This sign-in has expired. Sign in again.
            </Notice>
          ) : null}
          <Button kind="primary" label="Sign in again" onPress={backToSignIn} />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 20,
    gap: 16,
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
  },
  lead: { fontSize: 15, lineHeight: 21 },
  card: { padding: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
    minHeight: 52,
  },
  rowText: { flex: 1, gap: 2 },
  name: { fontSize: 17, fontWeight: '500' },
  actions: { gap: 12 },
});
