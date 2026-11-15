/**
 * Start a space: a device (online, trusted, a computer that takes remote
 * spaces), one of its projects, the goal, and a mode up to what that device
 * allows. Then straight into the new space.
 *
 * A native grouped form (docs/mobile.md "Native UI"):
 *
 * ```text
 * header      ‹ Back      Start a space      Start      (iOS, Android)
 * (no title)  Device   mac-A ⌄      Project   theodore ⌄
 * Goal        multiline field
 * Mode        Ask | Plan | Edit (up to the device's max)   footer: hint
 *             run warning, error
 *             Start                                      (web only)
 * ```
 *
 * The keyboard never hides Start: on iOS and Android it is in the header.
 * The goal is multiline (return is a newline); dragging the form closes the
 * keyboard, and on iOS so does a tap off a control.
 */
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, type Href } from 'expo-router';
import { KeyboardScreen } from '../../src/ui/KeyboardSafe';
import type { FleetMode } from '../../src/gen/fleet';
import { useServices } from '../../src/services';
import { useFleetState } from '../../src/state/fleet';
import { Empty, Notice } from '../../src/ui/kit';
import {
  MODE_HINT,
  MODE_LABEL,
  RUN_WARNING,
  capMode,
  errorText,
  modesUpTo,
  startableDevices,
} from '../../src/ui/logic';
import {
  Button,
  FormSlot,
  Section,
  Segmented,
  Select,
  TextField,
} from '../../src/ui/native';
import { ActionHeader } from '../../src/ui/start/ActionHeader';
import { KeyboardForm } from '../../src/ui/start/KeyboardForm';

const TITLE = 'Start a space';
const web = process.env.EXPO_OS === 'web';

export default function StartScreen() {
  const { fleet } = useServices();
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

  const startButton = (inHeader: boolean) => (
    <Button
      label="Start"
      variant={inHeader ? 'plain' : 'primary'}
      disabled={!ready}
      loading={busy}
      onPress={start}
    />
  );

  const header = (
    <Stack.Screen
      options={{
        title: TITLE,
        header: () => (
          <ActionHeader
            title={TITLE}
            action={!web && device ? startButton(true) : undefined}
          />
        ),
      }}
    />
  );

  if (devices.length === 0 || !device) {
    return (
      <View style={styles.empty}>
        {header}
        <Empty
          title="No computer can take a space right now"
          hint="It has to be one you trust, online, and set to let trusted devices run spaces. Trust it under Devices."
        />
      </View>
    );
  }

  const form = (
    <KeyboardForm testID="start-space">
      <Section>
        <Select
          label="Device"
          choices={devices.map((d) => ({ value: d.deviceId, label: d.name }))}
          value={device.deviceId}
          onChange={(id) => {
            const d = devices.find((x) => x.deviceId === id);
            setDeviceId(id);
            setProjectId(null);
            if (d) setMode((m) => capMode(m, d.maxMode));
          }}
        />
        <Select
          label="Project"
          choices={device.projects.map((x) => ({ value: x.id, label: x.name }))}
          value={project?.id ?? null}
          onChange={setProjectId}
        />
      </Section>

      <Section title="Goal">
        <TextField
          multiline
          minLines={4}
          placeholder="What should the agent work on?"
          value={goal}
          onChangeText={setGoal}
        />
      </Section>

      <Section
        title="Mode"
        footer={`${MODE_HINT[shownMode]}. ${device.name} allows up to ${MODE_LABEL[device.maxMode]}.`}
      >
        <Segmented
          label="Mode"
          choices={modesUpTo(device.maxMode).map((m) => ({
            value: m,
            label: MODE_LABEL[m],
          }))}
          value={shownMode}
          onChange={setMode}
        />
      </Section>

      {shownMode === 'run' ? (
        <Section>
          <FormSlot>
            <Notice tone="warning">{RUN_WARNING}</Notice>
          </FormSlot>
        </Section>
      ) : null}

      {error ? (
        <Section>
          <FormSlot>
            <Notice tone="danger">{error}</Notice>
          </FormSlot>
        </Section>
      ) : null}

      {web ? <Section>{startButton(false)}</Section> : null}
    </KeyboardForm>
  );

  return (
    <>
      {header}
      {/* iOS: SwiftUI keeps the focused field above the keyboard itself. */}
      {process.env.EXPO_OS === 'android' ? (
        <KeyboardScreen>{form}</KeyboardScreen>
      ) : (
        form
      )}
    </>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, padding: 16 },
});
