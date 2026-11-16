/**
 * Home: start a new space, in the chat template's empty-chat style. The
 * goal is the first message; where it runs and how are the composer's
 * chips (docs/mobile.md "New space").
 *
 * ```text
 * [☰]            New space           [🔔][✎]
 *  (questions waiting, connection)
 *
 *                  ⌘  New space
 *       It runs on your computer; follow it from here.
 *        ( api · build-box ) ( web · mac-A )        recent projects: one tap
 *
 *  ╭ Run lets the agent run any command… ╮          only in Run
 * ╭──────────────────────────────────────────────╮
 * │ What should the agent work on?               │
 * │ (mac-A · repo ⌄)(Opus 4.1 · High ⌄)(Edit ⌄)(↑)│  chips scroll sideways
 * ╰──────────────────────────────────────────────╯
 *
 * picks: src/state/compose.ts (shared with the sheets, remembered per
 *        account + org); only what was picked is sent
 * ✎ / drawer "New space" ─▶ the goal cleared, the composer focused
 *        (not at a cold start: the keyboard would cover Home at launch)
 * no computer can take one ─▶ "No computer can take a space right now…",
 *                             Devices, the composer off
 * Send ─▶ fleet.startSpace ─▶ recent projects ─▶ push /space/<id>
 * ```
 */
import { router, type Href } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  Pressable,
  Text,
  View,
  type TextInputInstance,
} from 'react-native';
import { ComposerDock, PromptInput } from '../../src/components/chat';
import { MainHeader } from '../../src/components/main-header';
import {
  ModeMenu,
  ModelChip,
  WhereChip,
} from '../../src/components/pickers/composer-chips';
import { useHome } from '../../src/components/pickers/use-picker';
import { SymbolImage } from '../../src/components/symbol-image';
import { useServices } from '../../src/services';
import { useGlassHeaderInset } from '../../src/shell/glassHeader';
import { spaceHref } from '../../src/shell/navigate';
import {
  applyWhere,
  noteStarted,
  requestNewSpace,
  setHomeMode,
  useCompose,
} from '../../src/state/compose';
import { startPicks } from '../../src/ui/agents';
import { ConnectionBanner } from '../../src/ui/ConnectionBanner';
import { recentChips } from '../../src/ui/homeDraft';
import { RUN_WARNING, errorText, modesUpTo } from '../../src/ui/logic';
import { Button, Glass } from '../../src/ui/native';
import { QuestionsBanner } from '../../src/ui/QuestionsBanner';
import { usePalette } from '../../src/ui/theme';

const TITLE = 'New space';
const PLACEHOLDER = 'What should the agent work on?';
const HINT = 'It runs on your computer; follow it from here.';
const web = process.env.EXPO_OS === 'web';

export default function NewSpaceScreen() {
  const { fleet } = useServices();
  const p = usePalette();
  const top = useGlassHeaderInset();
  const { device, project, mode, pick, startable } = useHome();
  const recent = useCompose((s) => s.recent);
  const fresh = useCompose((s) => s.fresh);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<TextInputInstance>(null);

  // "New space" (✎, the drawer): a clean field, focused. Not at a cold
  // start: only a request made after Home mounted.
  const handled = useRef(fresh);
  useEffect(() => {
    if (fresh === handled.current) return;
    handled.current = fresh;
    setGoal('');
    setError(null);
    // After the pop back to Home and the drawer's close.
    const t = setTimeout(() => input.current?.focus(), web ? 0 : 300);
    return () => clearTimeout(t);
  }, [fresh]);

  const quick = useMemo(
    () =>
      recentChips(
        recent,
        startable,
        device && project
          ? { deviceId: device.deviceId, projectId: project.id }
          : null,
      ),
    [recent, startable, device, project],
  );

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
        mode,
        ...startPicks(device.agents, pick),
      })
      .then((space) => {
        if (!web)
          void Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
        noteStarted(device.deviceId, project.id);
        setGoal('');
        router.push(spaceHref(space.space));
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  const chips =
    device && project ? (
      <>
        <WhereChip disabled={busy} />
        <ModelChip disabled={busy} />
        <ModeMenu
          modes={modesUpTo(device.maxMode)}
          value={mode}
          onChange={setHomeMode}
          disabled={busy}
          testID="start-mode"
        />
      </>
    ) : null;

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: top }}>
      <MainHeader title={TITLE} onNewSpace={requestNewSpace} />
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
            <Text className="max-w-xs text-center text-sm text-muted-foreground">
              {HINT}
            </Text>
            {quick.length > 0 ? (
              <View className="mt-3 flex-row flex-wrap justify-center gap-2">
                {quick.map((r) => (
                  <Button
                    key={`${r.deviceId}/${r.projectId}`}
                    label={r.label}
                    accessibilityLabel={r.accessibilityLabel}
                    variant="secondary"
                    pill
                    onPress={() => applyWhere(r.deviceId, r.projectId)}
                  />
                ))}
              </View>
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
        {device && mode === 'run' ? (
          <Glass radius={20} style={{ padding: 12, marginBottom: 8 }}>
            <Text className="text-[13px] text-warning">{RUN_WARNING}</Text>
          </Glass>
        ) : null}
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
          autoFocus={web}
          inputRef={input}
          testID="start-space"
        />
      </ComposerDock>
    </View>
  );
}
