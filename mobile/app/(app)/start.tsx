/**
 * Start a space: a device (online, trusted, a computer that takes remote
 * spaces), one of its projects, the goal, and a mode up to what that device
 * allows. Then straight into the new space.
 *
 * A native grouped form (docs/mobile.md "Native UI"):
 *
 * ```text
 * header      ‹ Back      Start a space      Start      (iOS, Android)
 *             iOS 26+: the native glass bar, Start a prominent glass item
 * (no title)  Device   mac-A ⌄      Project   theodore ⌄
 * Goal        multiline field
 * Mode        Ask | Plan | Edit (up to the device's max)   footer: hint
 *             run warning
 * Agent       Agent ⌄  Model ⌄  Effort ⌄     only when the device lists
 *             "Default (Opus 4.1)": its own    agents; efforts: the model's
 *             error
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
import type { FleetAgentView } from '../../src/fleet/types';
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
import { glassHeader, useGlassHeaderInset } from '../../src/shell/glassHeader';
import { usePalette } from '../../src/ui/theme';
import {
  NO_PICK,
  effortLabel,
  pickAgent,
  pickEffort,
  pickModel,
  running,
  startPicks,
  type Pick,
} from '../../src/ui/agents';
import { ActionHeader } from '../../src/ui/start/ActionHeader';
import { KeyboardForm } from '../../src/ui/start/KeyboardForm';

const TITLE = 'Start a space';
/** A Select's "the device's own" choice (no listed id is empty). */
const DEFAULT = '';
const web = process.env.EXPO_OS === 'web';

export default function StartScreen() {
  const { fleet } = useServices();
  const p = usePalette();
  const top = useGlassHeaderInset();
  const allDevices = useFleetState((s) => s.devices);
  const devices = useMemo(() => startableDevices(allDevices), [allDevices]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [mode, setMode] = useState<FleetMode>('edit');
  // Only what's picked goes; the device's own defaults run for the rest.
  const [pick, setPick] = useState<Pick>(NO_PICK);
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
        ...startPicks(device.agents, pick),
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

  const header = glassHeader ? (
    // iOS 26+: a bar button item on the native glass bar; busy reads as
    // disabled (a bar item has no spinner).
    <Stack.Screen
      options={{
        title: TITLE,
        unstable_headerRightItems: () =>
          device
            ? [
                {
                  type: 'button',
                  label: 'Start',
                  variant: 'prominent',
                  tintColor: p.accent,
                  disabled: !ready,
                  onPress: start,
                },
              ]
            : [],
      }}
    />
  ) : (
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
      <View style={[styles.empty, top ? { paddingTop: 16 + top } : null]}>
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
            // Another device lists its own agents and models.
            setPick(NO_PICK);
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

      <AgentSection
        agents={device.agents}
        deviceName={device.name}
        pick={pick}
        onPick={setPick}
      />

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

/**
 * Agent, model and effort on the chosen device, each "Default (…)" = what
 * it runs when nothing is picked. None when it lists no agents (older).
 */
function AgentSection({
  agents,
  deviceName,
  pick,
  onPick,
}: {
  agents: readonly FleetAgentView[];
  deviceName: string;
  pick: Pick;
  onPick: (next: Pick) => void;
}) {
  const now = running(agents, pick);
  const byDefault = running(agents, NO_PICK);
  if (!now || !byDefault) return null;
  // The defaults of the agent shown; for the effort, of the model shown.
  const ownModel = running(agents, { ...NO_PICK, agent: pick.agent });
  const ownEffort = running(agents, { ...pick, effort: null });
  const defaultOf = (what: string | null | undefined) =>
    what ? `Default (${what})` : 'Default';
  return (
    <Section
      title="Agent"
      footer={`What runs on ${deviceName}. Default: its own setting.`}
    >
      <Select
        label="Agent"
        choices={[
          { value: DEFAULT, label: defaultOf(byDefault.agent.label) },
          ...agents.map((a) => ({ value: a.id, label: a.label })),
        ]}
        value={pick.agent ?? DEFAULT}
        onChange={(v) => onPick(v === DEFAULT ? NO_PICK : pickAgent(v))}
      />
      {now.agent.models.length > 0 ? (
        <Select
          label="Model"
          choices={[
            {
              value: DEFAULT,
              label: defaultOf(ownModel?.model?.label ?? ownModel?.modelId),
            },
            ...now.agent.models.map((m) => ({ value: m.id, label: m.label })),
          ]}
          value={pick.model ?? DEFAULT}
          onChange={(v) =>
            onPick(pickModel(agents, pick, NO_PICK, v === DEFAULT ? null : v))
          }
        />
      ) : null}
      {now.levels.length > 0 ? (
        <Select
          label="Effort"
          choices={[
            {
              value: DEFAULT,
              label: defaultOf(
                ownEffort?.effort ? effortLabel(ownEffort.effort) : null,
              ),
            },
            ...now.levels.map((e) => ({ value: e, label: effortLabel(e) })),
          ]}
          value={pick.effort ?? DEFAULT}
          onChange={(v) => onPick(pickEffort(pick, v === DEFAULT ? null : v))}
        />
      ) : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, padding: 16 },
});
