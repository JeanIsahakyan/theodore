/**
 * Home: start a new space, in the chat template's empty-chat style. The
 * goal is the first message; where it runs and how are chips.
 *
 * ```text
 * [☰]            New space           [🔔][✎]
 *  (questions waiting, connection)
 *
 *                  ⌘  New space
 *          Runs on ( mac-A · theodore ⌄ )        Device ─ Project picker
 *            Edit files in the space
 *
 * ╭──────────────────────────────────────────╮
 * │ What should the agent work on?           │
 * │ (Edit ⌄) (Opus 4.1 · High ⌄)         (↑) │   Mode up to the device's cap,
 * ╰──────────────────────────────────────────╯   agent · model · effort
 *
 * no computer can take one ─▶ "No computer can take a space right now…",
 *                             Devices, the composer off
 * Send ─▶ fleet.startSpace ─▶ push /space/<id>, the field cleared
 * ```
 */
import { router, type Href } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useMemo, useState } from 'react';
import { Keyboard, Pressable, Text, View } from 'react-native';
import { ComposerDock, PromptInput } from '../../src/components/chat';
import { MainHeader } from '../../src/components/main-header';
import { PickerMenu } from '../../src/components/picker-menu';
import { SymbolImage } from '../../src/components/symbol-image';
import type { FleetMode } from '../../src/gen/fleet';
import { useServices } from '../../src/services';
import { useGlassHeaderInset } from '../../src/shell/glassHeader';
import { spaceHref } from '../../src/shell/navigate';
import { useFleetState } from '../../src/state/fleet';
import { AgentMenu } from '../../src/ui/AgentMenu';
import { NO_PICK, startPicks, type Pick } from '../../src/ui/agents';
import { ConnectionBanner } from '../../src/ui/ConnectionBanner';
import {
  MODE_HINT,
  MODE_LABEL,
  RUN_WARNING,
  capMode,
  errorText,
  modesUpTo,
  startableDevices,
} from '../../src/ui/logic';
import { Button } from '../../src/ui/native';
import { QuestionsBanner } from '../../src/ui/QuestionsBanner';
import { usePalette } from '../../src/ui/theme';

const TITLE = 'New space';
const PLACEHOLDER = 'What should the agent work on?';
const web = process.env.EXPO_OS === 'web';

export default function NewSpaceScreen() {
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

  const reset = () => {
    setGoal('');
    setError(null);
  };

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
      .then((space) => {
        if (!web)
          void Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
        setGoal('');
        router.push(spaceHref(space.space));
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  const chooseDevice = (id: string) => {
    const d = devices.find((x) => x.deviceId === id);
    setDeviceId(id);
    setProjectId(null);
    // Another device lists its own agents and models.
    setPick(NO_PICK);
    if (d) setMode((m) => capMode(m, d.maxMode));
  };

  const chips = device ? (
    <>
      <PickerMenu
        label={MODE_LABEL[shownMode]}
        accessibilityLabel={`Mode: ${MODE_LABEL[shownMode]}`}
        groups={[
          {
            label: 'Mode',
            choices: modesUpTo(device.maxMode).map((m) => ({
              value: m,
              label: MODE_LABEL[m],
            })),
            value: shownMode,
            onChange: (m) => setMode(m as FleetMode),
          },
        ]}
        disabled={busy}
        testID="start-mode"
      />
      <AgentMenu
        agents={device.agents}
        pick={pick}
        current={NO_PICK}
        onPick={setPick}
        disabled={busy}
        glass={false}
      />
    </>
  ) : null;

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: top }}>
      <MainHeader title={TITLE} onNewSpace={reset} />
      <QuestionsBanner glass />
      <ConnectionBanner style={{ alignSelf: 'center', marginTop: 8 }} />

      <Pressable
        accessible={false}
        onPress={web ? undefined : Keyboard.dismiss}
        className="flex-1 items-center justify-center gap-2 px-6"
      >
        {device && project ? (
          <>
            <SymbolImage name="chat" size={44} color={p.muted} />
            <Text
              accessibilityRole="header"
              className="text-xl font-semibold text-foreground"
            >
              {TITLE}
            </Text>
            <View className="flex-row flex-wrap items-center justify-center gap-2">
              <Text className="text-sm text-muted-foreground">Runs on</Text>
              <PickerMenu
                label={`${device.name} · ${project.name}`}
                accessibilityLabel={`Runs on ${device.name}, project ${project.name}`}
                groups={[
                  {
                    label: 'Device',
                    choices: devices.map((d) => ({
                      value: d.deviceId,
                      label: d.name,
                    })),
                    value: device.deviceId,
                    onChange: chooseDevice,
                  },
                  {
                    label: 'Project',
                    choices: device.projects.map((x) => ({
                      value: x.id,
                      label: x.name,
                    })),
                    value: project.id,
                    onChange: setProjectId,
                  },
                ]}
                disabled={busy}
                testID="start-where"
              />
            </View>
            <Text className="max-w-xs text-center text-[13px] text-muted-foreground">
              {`${MODE_HINT[shownMode]}. ${device.name} allows up to ${MODE_LABEL[device.maxMode]}.`}
            </Text>
            {shownMode === 'run' ? (
              <Text className="max-w-xs text-center text-[13px] text-warning">
                {RUN_WARNING}
              </Text>
            ) : null}
          </>
        ) : (
          <>
            <SymbolImage name="computer" size={44} color={p.muted} />
            <Text
              accessibilityRole="header"
              className="text-center text-xl font-semibold text-foreground"
            >
              No computer can take a space right now
            </Text>
            <Text className="max-w-xs text-center text-sm text-muted-foreground">
              It has to be one you trust, online, and set to let trusted devices
              run spaces. Trust it under Devices.
            </Text>
            <Button
              label="Devices"
              variant="secondary"
              onPress={() => router.push('/devices' as Href)}
              style={{ marginTop: 8 }}
            />
          </>
        )}
      </Pressable>

      <ComposerDock>
        <PromptInput
          value={goal}
          onChangeText={setGoal}
          onSubmit={start}
          placeholder={PLACEHOLDER}
          submitLabel="Start"
          disabled={!device || !project}
          sending={busy}
          canSubmit={ready}
          leading={chips}
          error={error}
          testID="start-space"
        />
      </ComposerDock>
    </View>
  );
}
