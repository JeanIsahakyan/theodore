/**
 * A computer's auto mode for one Claude via the cloud device it pins
 * (docs/fleet.md "Auto mode"), on its card on the Devices page. Sent as a
 * signed `set_mcp_auto` to that computer (trusted here); what it says now
 * comes back in the next devices list.
 *
 * ```text
 * Claude via cloud                  until 18:00
 * [ Off | Auto Edit | Full auto ]
 *   Auto Edit / Full auto ─▶ For how long?  (1 hour) (Until end of day)
 *                                           (Until I turn it off) (Cancel)
 *   Off ─▶ sent at once
 * Its key is held by the Theodore cloud: with auto on, …   (when on)
 * ```
 */
import { useState } from 'react';
import { Text, View } from 'react-native';
import type { McpAuto } from '../../gen/fleet';
import type { McpAutoView } from '../../fleet/types';
import { useServices } from '../../services';
import {
  AUTO_CHOICES,
  AUTO_DURATIONS,
  autoExpiry,
  autoUntil,
  autoWarning,
  type AutoDuration,
} from '../../ui/confirmView';
import { errorText } from '../../ui/logic';
import { Button, Segmented } from '../../ui/native';

export function McpAutoControl({
  host,
  hostName,
  entry,
  trusted,
}: {
  host: string;
  hostName: string;
  entry: McpAutoView;
  /** The computer is pinned here (a request needs it). */
  trusted: boolean;
}) {
  const { fleet } = useServices();
  /** Picked, waiting for a duration. */
  const [choosing, setChoosing] = useState<McpAuto | null>(null);
  /** Sent and accepted, shown until the devices list says anything new. */
  const [sent, setSent] = useState<{
    auto: McpAuto;
    untilMs: number | null;
    /** What the list said when it was sent. */
    over: McpAutoView;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only to tell "until 18:00" (today) from a later day.
  const [now] = useState(Date.now);

  const current =
    sent && sent.over.auto === entry.auto && sent.over.untilMs === entry.untilMs
      ? sent
      : entry;
  const shown = choosing ?? current.auto;
  const warning = autoWarning(shown);

  const send = (auto: McpAuto, untilMs: number | null) => {
    setBusy(true);
    setError(null);
    setChoosing(null);
    fleet
      .setMcpAuto(host, entry.deviceId, auto, untilMs)
      .then(() => setSent({ auto, untilMs, over: entry }))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  const pick = (auto: McpAuto) => {
    if (busy) return;
    setError(null);
    if (auto === 'off') {
      setChoosing(null);
      if (current.auto !== 'off') send('off', null);
      return;
    }
    setChoosing(auto);
  };

  const pickDuration = (d: AutoDuration) => {
    if (choosing) send(choosing, autoUntil(d));
  };

  return (
    <View
      testID={`mcp-auto-${entry.deviceId}`}
      className="gap-2 border-t border-border pt-3"
    >
      <View className="flex-row items-center justify-between gap-3">
        <Text
          numberOfLines={1}
          className="flex-1 text-[15px] font-medium text-foreground"
        >
          {entry.name}
        </Text>
        <Text className="text-[13px] text-muted-foreground">
          {autoExpiry(current.auto, current.untilMs, now)}
        </Text>
      </View>
      <Segmented<McpAuto>
        label={`Auto mode for ${entry.name} on ${hostName}`}
        choices={AUTO_CHOICES}
        value={shown}
        onChange={pick}
        disabled={busy || !trusted}
      />
      {choosing ? (
        <View className="gap-1">
          <Text className="text-[13px] text-muted-foreground">
            For how long?
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {AUTO_DURATIONS.map((d) => (
              <Button
                key={d.value}
                label={d.label}
                variant="secondary"
                pill
                onPress={() => pickDuration(d.value)}
              />
            ))}
            <Button
              label="Cancel"
              variant="plain"
              pill
              onPress={() => setChoosing(null)}
            />
          </View>
        </View>
      ) : null}
      {!trusted ? (
        <Text className="text-[13px] leading-snug text-muted-foreground">
          Trust this computer to change it.
        </Text>
      ) : null}
      {warning ? (
        <Text className="text-[13px] leading-snug text-warning">{warning}</Text>
      ) : null}
      {error ? (
        <Text
          accessibilityLiveRegion="polite"
          className="text-[13px] leading-snug text-danger"
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}
