/**
 * A request from Claude via the cloud waiting on one of your computers
 * for Allow / Deny (docs/fleet.md "Requests from Claude via the cloud").
 * Drawn like `QuestionCard` (same card, same warning tint). The card goes
 * once the answer is sent; the banner shows a refusal.
 *
 * ```text
 * ╭──────────────────────────────────────────────╮
 * │ ● Claude via cloud wants to start an Edit    │
 * │   space in theodore on Studio                │
 * │ Fix the flaky login test                     │   plain text
 * │ Unanswered by 18:05, it is refused           │
 * │ (       Deny       ) (       Allow        )  │
 * ╰──────────────────────────────────────────────╯
 * ```
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ConfirmView } from '../fleet/types';
import { useServices } from '../services';
import { track } from '../telemetry/log';
import { confirmDeadline, confirmTitle } from './confirmView';
import { refusalCode } from './logic';
import { Button, Glass, liquidGlass } from './native';
import { usePalette } from './theme';

export function ConfirmCard({
  confirm,
  glass,
  onError,
}: {
  confirm: ConfirmView;
  glass?: boolean;
  /** The answer was refused (the card is gone by then). */
  onError: (e: unknown) => void;
}) {
  const { fleet } = useServices();
  const p = usePalette();
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);

  const answer = (allow: boolean) => {
    if (busy) return;
    setBusy(allow ? 'allow' : 'deny');
    fleet
      .confirm(confirm.hostDevice, confirm.confirmId, allow)
      .then(() =>
        track('confirm_answered', {
          allow,
          over: 'socket',
          outcome: 'ok',
          code: null,
        }),
      )
      .catch((e: unknown) => {
        track('confirm_answered', {
          allow,
          over: 'socket',
          outcome: 'failed',
          code: refusalCode(e),
        });
        onError(e);
      })
      .finally(() => setBusy(null));
  };

  const content = (
    <>
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: p.warning }]} />
        <Text selectable style={[styles.title, { color: p.warning }]}>
          {confirmTitle(confirm)}
        </Text>
      </View>
      {confirm.text ? (
        <Text selectable style={[styles.text, { color: p.text }]}>
          {confirm.text}
        </Text>
      ) : null}
      <Text style={[styles.deadline, { color: p.muted }]}>
        {confirmDeadline(confirm.expiresAtMs)}
      </Text>
      <View style={styles.actions}>
        <Button
          label="Deny"
          variant="destructive"
          pill
          fullWidth
          style={styles.action}
          disabled={busy !== null}
          loading={busy === 'deny'}
          accessibilityLabel={`Deny: ${confirmTitle(confirm)}`}
          onPress={() => answer(false)}
        />
        <Button
          label="Allow"
          variant={glass ? 'glassProminent' : 'primary'}
          pill
          fullWidth
          style={styles.action}
          disabled={busy !== null}
          loading={busy === 'allow'}
          accessibilityLabel={`Allow: ${confirmTitle(confirm)}`}
          onPress={() => answer(true)}
        />
      </View>
    </>
  );

  return glass && liquidGlass ? (
    <Glass radius={22} tint={`${p.warning}26`} style={styles.card}>
      {content}
    </Glass>
  ) : (
    <View
      className="rounded-[22px] border bg-card"
      style={[styles.card, { borderColor: `${p.warning}66` }]}
    >
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  title: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  text: { fontSize: 16, lineHeight: 22 },
  deadline: { fontSize: 12 },
  actions: { flexDirection: 'row', gap: 8 },
  action: { flex: 1 },
  card: { padding: 16, gap: 12, borderCurve: 'continuous' },
});
