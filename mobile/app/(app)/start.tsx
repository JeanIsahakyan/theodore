/**
 * Start a space: a device (online, trusted, a computer that takes remote
 * spaces), one of its projects, the goal, and a mode up to what that device
 * allows. Then straight into the new space.
 */
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, router, type Href } from 'expo-router';
import type { FleetMode } from '../../src/gen/fleet';
import { useServices } from '../../src/services';
import { useFleetState } from '../../src/state/fleet';
import {
  Button,
  Chip,
  Empty,
  Field,
  Notice,
  SectionTitle,
} from '../../src/ui/kit';
import {
  MODE_HINT,
  MODE_LABEL,
  RUN_WARNING,
  capMode,
  errorText,
  modesUpTo,
  startableDevices,
} from '../../src/ui/logic';
import { usePalette } from '../../src/ui/theme';

export default function StartScreen() {
  const { fleet } = useServices();
  const p = usePalette();
  const allDevices = useFleetState((s) => s.devices);
  const devices = useMemo(() => startableDevices(allDevices), [allDevices]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [mode, setMode] = useState<FleetMode>('edit');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The device picked, else the first; its first project likewise.
  const device = devices.find((d) => d.deviceId === deviceId) ?? devices[0];
  const project =
    device?.projects.find((x) => x.id === projectId) ?? device?.projects[0];
  const shownMode = device ? capMode(mode, device.maxMode) : mode;
  const ready = !!device && !!project && goal.trim() !== '' && !busy;

  const start = () => {
    if (!device || !project || !ready) return;
    setBusy(true);
    setError(null);
    fleet
      .startSpace({
        deviceId: device.deviceId,
        projectId: project.id,
        goal: goal.trim(),
        mode: shownMode,
      })
      .then((space) => router.replace(`/space/${space.space}` as Href))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'Start a space' }} />
      {devices.length === 0 || !device ? (
        <Empty
          title="No computer can take a space right now"
          hint="It has to be one you trust, online, and set to let trusted devices run spaces. Trust it under Devices."
        />
      ) : (
        <>
          <SectionTitle>Device</SectionTitle>
          <View style={styles.choices}>
            {devices.map((d) => (
              <Chip
                key={d.deviceId}
                label={d.name}
                selected={d.deviceId === device.deviceId}
                onPress={() => {
                  setDeviceId(d.deviceId);
                  setProjectId(null);
                  setMode((m) => capMode(m, d.maxMode));
                }}
              />
            ))}
          </View>

          <SectionTitle>Project</SectionTitle>
          <View style={styles.choices}>
            {device.projects.map((x) => (
              <Chip
                key={x.id}
                label={x.name}
                selected={x.id === project?.id}
                onPress={() => setProjectId(x.id)}
              />
            ))}
          </View>

          <SectionTitle>Goal</SectionTitle>
          <Field
            label="Goal"
            multiline
            numberOfLines={4}
            placeholder="What should the agent work on?"
            value={goal}
            onChangeText={setGoal}
            style={styles.goal}
          />

          <SectionTitle>Mode</SectionTitle>
          <View style={styles.choices}>
            {modesUpTo(device.maxMode).map((m) => (
              <Chip
                key={m}
                label={MODE_LABEL[m]}
                selected={m === shownMode}
                onPress={() => setMode(m)}
              />
            ))}
          </View>
          <Text style={[styles.hint, { color: p.muted }]}>
            {MODE_HINT[shownMode]}. {device.name} allows up to{' '}
            {MODE_LABEL[device.maxMode]}.
          </Text>
          {shownMode === 'run' ? (
            <Notice tone="warning">{RUN_WARNING}</Notice>
          ) : null}

          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Button
            label="Start"
            kind="primary"
            disabled={!ready}
            busy={busy}
            onPress={start}
          />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  goal: { minHeight: 110, textAlignVertical: 'top' },
  hint: { fontSize: 13 },
});
