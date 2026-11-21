/**
 * Home: start a new space, in the chat template's empty-chat style. The
 * goal is the first message; where it runs is two chips under the hint,
 * the model a chip in the composer, the mode in the computer's sheet
 * (docs/mobile.md "New space").
 *
 * ```text
 * [☰]            New space           [🔔][✎]
 *  (questions waiting, connection)
 *
 *                  ⌘  New space
 *       It runs on your computer; follow it from here.
 *
 *        ( 📁 theodore ⌄ )  on  ( 🖥 mac-A ⌄ )    WhereChips: project sheet,
 *                                                  computer sheet (+ Mode)
 *  ╭ Run lets the agent run any command… ╮          only in Run
 * ╭──────────────────────────────────────────────╮
 * │ What should the agent work on?               │
 * │ (Opus 4.1 High ⌄)                        (↑) │  the model chip
 * ╰──────────────────────────────────────────────╯
 *
 * picks: src/state/compose.ts (shared with the sheets, remembered per
 *        account + org); only what was picked is sent
 * ✎ (the header)   ─▶ the goal cleared, the composer focused
 *        (not at a cold start: the keyboard would cover Home at launch)
 * no computer can take one ─▶ "No computer can take a space right now…",
 *                             Devices, the composer off
 * Send ─▶ /space/pending_<n> at once (the goal as your bubble, "Starting
 *        on mac-A…"), no slide, its header the main one (☰), not Back
 *        ─▶ fleet.startSpace ─▶ ok: recent projects, the route becomes the
 *           space's; refused: back here, the goal in the field, the error
 * ```
 */
import { router, type Href } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  Pressable,
  Text,
  View,
  type TextInputInstance,
} from 'react-native';
import { ComposerDock, PromptInput } from '../../src/components/chat';
import { MainHeader } from '../../src/components/main-header';
import { ModelChip } from '../../src/components/pickers/composer-chips';
import { useHome } from '../../src/components/pickers/use-picker';
import { WhereChips } from '../../src/components/pickers/where-chips';
import { SymbolImage } from '../../src/components/symbol-image';
import { useServices } from '../../src/services';
import { useGlassHeaderInset } from '../../src/shell/glassHeader';
import { spaceHref } from '../../src/shell/navigate';
import {
  noteStarted,
  requestNewSpace,
  useCompose,
} from '../../src/state/compose';
import {
  addStart,
  startFailed,
  startSettled,
  takeHomeRestore,
  usePending,
} from '../../src/state/pending';
import { startPicks } from '../../src/ui/agents';
import { ConnectionBanner } from '../../src/ui/ConnectionBanner';
import { RUN_WARNING, errorText } from '../../src/ui/logic';
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
  const { device, project, mode, pick } = useHome();
  const fresh = useCompose((s) => s.fresh);
  const [goal, setGoal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<TextInputInstance>(null);

  // A start the host refused: its goal back in the field, with why. Home
  // is the stack's anchor, mounted before any start: it hears every one.
  useEffect(
    () =>
      usePending.subscribe((s, prev) => {
        if (!s.homeRestore || s.homeRestore === prev.homeRestore) return;
        const back = takeHomeRestore();
        if (!back) return;
        setGoal(back.goal);
        setError(back.error);
      }),
    [],
  );

  // "New space" (✎ in the header): a clean field, focused. Not at a cold
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

  const ready = !!device && !!project && goal.trim() !== '';

  // The space's screen opens at once under a pending id, the goal as your
  // first bubble; the host's ok names the space and the route follows
  // (src/state/pending.ts). Refused: back here, the goal in the field.
  const start = () => {
    if (!device || !project || !ready) return;
    const text = goal.trim();
    const picks = startPicks(device.agents, pick);
    setError(null);
    setGoal('');
    const id = addStart({
      deviceId: device.deviceId,
      hostName: device.name,
      projectId: project.id,
      projectName: project.name,
      goal: text,
      mode,
      picks,
    });
    router.push(spaceHref(id));
    fleet
      .startSpace({
        deviceId: device.deviceId,
        projectId: project.id,
        goal: text,
        mode,
        ...picks,
      })
      .then((space) => {
        if (!web)
          void Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
        noteStarted(device.deviceId, project.id);
        startSettled(id, space.space);
      })
      .catch((e: unknown) => startFailed(id, errorText(e)));
  };

  const chips = device && project ? <ModelChip /> : null;

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
            <View className="mt-3 w-full">
              <WhereChips />
            </View>
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
