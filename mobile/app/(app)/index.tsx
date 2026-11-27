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
 * before the first devices list of this run (src/ui/load.ts)
 *   ─▶ skeleton chips (the last picks muted, when saved spaces name them),
 *      "Connecting to your devices…"; typing allowed, Send off
 *   error, or 10 s connecting ─▶ "Can't reach the server", Retry (fleet.start)
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
import {
  AttachButton,
  AttachmentStrip,
  ComposerDock,
  PromptInput,
  useAttach,
} from '../../src/components/chat';
import { MainHeader } from '../../src/components/main-header';
import { ModelChip } from '../../src/components/pickers/composer-chips';
import { useHome } from '../../src/components/pickers/use-picker';
import { WhereChips } from '../../src/components/pickers/where-chips';
import { SymbolImage } from '../../src/components/symbol-image';
import { useServices } from '../../src/services';
import { useGlassHeaderInset } from '../../src/shell/glassHeader';
import { spaceHref } from '../../src/shell/navigate';
import { HOME_COMPOSER } from '../../src/state/attachments';
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
import { useAccountSwitch } from '../../src/state/accounts';
import { useFleetState } from '../../src/state/fleet';
import { log, track } from '../../src/telemetry/log';
import { startPicks } from '../../src/ui/agents';
import { SharingCard } from '../../src/ui/SharingCard';
import { allUploaded } from '../../src/ui/attachments';
import { ConnectionBanner } from '../../src/ui/ConnectionBanner';
import {
  UNREACHABLE_TITLE,
  lastPicksPreview,
  loadingText,
  unreachableHint,
} from '../../src/ui/load';
import { RUN_WARNING, errorText, refusalCode } from '../../src/ui/logic';
import { Button, Glass } from '../../src/ui/native';
import { ConfirmsBanner } from '../../src/ui/ConfirmsBanner';
import { SkeletonChip } from '../../src/ui/Skeleton';
import { Spinner } from '../../src/ui/Spinner';
import { usePalette } from '../../src/ui/theme';
import { useHomeLoadState } from '../../src/ui/useLoadState';

const TITLE = 'New space';
const PLACEHOLDER = 'What should the agent work on?';
const HINT = 'It runs on your computer; follow it from here.';
const web = process.env.EXPO_OS === 'web';

export default function NewSpaceScreen() {
  const { fleet } = useServices();
  const p = usePalette();
  const top = useGlassHeaderInset();
  const { device, project, mode, pick, startable } = useHome();
  const fresh = useCompose((s) => s.fresh);
  const load = useHomeLoadState(startable.length > 0);
  const [goal, setGoal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<TextInputInstance>(null);
  // Files for the space's .context/, sealed for the picked computer and
  // uploaded on pick (docs/mobile.md "Files").
  const attach = useAttach(HOME_COMPOSER, device?.deviceId ?? null);

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

  // Start waits for every attached file to be in the cloud.
  const ready =
    !!device && !!project && goal.trim() !== '' && allUploaded(attach.list);

  // The space's screen opens at once under a pending id, the goal as your
  // first bubble; the host's ok names the space and the route follows
  // (src/state/pending.ts). Refused: back here, the goal in the field.
  const start = () => {
    if (!device || !project || !ready) return;
    const text = goal.trim();
    const picks = startPicks(device.agents, pick);
    const { refs, files } = attach.take();
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
      files,
    });
    router.push(spaceHref(id));
    const startedAt = Date.now();
    const facts = {
      computer_kind: device.kind,
      mode,
      agent: picks.agent ?? null,
      model: picks.model ?? null,
      effort: picks.effort ?? null,
    };
    log.info('space start requested', {
      op_id: id,
      host_device: device.deviceId,
      ...facts,
    });
    fleet
      .startSpace({
        deviceId: device.deviceId,
        projectId: project.id,
        goal: text,
        mode,
        ...picks,
        attachments: refs,
      })
      .then((space) => {
        if (!web)
          void Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
        track('space_started', {
          ...facts,
          ms: Date.now() - startedAt,
          outcome: space.status === 'starting' ? 'timeout' : 'ok',
          code: null,
        });
        noteStarted(device.deviceId, project.id);
        startSettled(id, space.space);
      })
      .catch((e: unknown) => {
        const code = refusalCode(e);
        track('space_started', {
          ...facts,
          ms: Date.now() - startedAt,
          outcome: 'refused',
          code,
        });
        log.warn('space start refused', {
          op_id: id,
          'error.code': code ?? 'fleet.refused',
        });
        startFailed(id, errorText(e));
      });
  };

  // Loading or unreachable: a chip-sized placeholder where the model chip
  // goes; the field takes typing, Send waits for the devices.
  const settled = load === 'ready' || load === 'empty';
  const chips =
    device && project ? (
      <>
        <AttachButton
          onPick={(s) => void attach.pick(s)}
          busy={attach.picking}
          testID="start-attach"
        />
        <ModelChip />
      </>
    ) : settled ? null : (
      <SkeletonChip />
    );

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: top }}>
      <MainHeader title={TITLE} onNewSpace={requestNewSpace} />
      <SharingCard />
      <ConfirmsBanner glass />
      {/* Before the first list, Home itself says what the link does. */}
      {settled ? (
        <ConnectionBanner style={{ alignSelf: 'center', marginTop: 8 }} />
      ) : null}

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
        ) : !settled ? (
          <FirstConnect
            unreachable={load === 'unreachable'}
            onRetry={() => void fleet.start()}
          />
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
          // Loading: the goal can be typed already; Send waits for a computer.
          disabled={settled && (!device || !project)}
          canSubmit={ready}
          above={
            <AttachmentStrip
              list={attach.list}
              notice={attach.notice}
              onRetry={attach.retry}
              onRemove={attach.remove}
            />
          }
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

/**
 * Home before this run's first devices list: the title, the where chips as
 * skeletons (or the last picks, muted, when a saved space names them), and
 * either "Connecting to your devices…" or why the server can't be reached
 * with Retry.
 */
function FirstConnect({
  unreachable,
  onRetry,
}: {
  unreachable: boolean;
  onRetry: () => void;
}) {
  const p = usePalette();
  const error = useFleetState((s) => s.error);
  const spaces = useFleetState((s) => s.spaces);
  const draft = useCompose((s) => s.home);
  const switching = useAccountSwitch((s) => s.switching);
  const last = lastPicksPreview(draft, spaces);
  const loading = loadingText(switching);
  return (
    <>
      <SymbolImage name="chat" size={44} color={p.muted} />
      <Text
        accessibilityRole="header"
        className="text-xl font-semibold text-foreground"
      >
        {TITLE}
      </Text>
      <View
        testID="start-where-loading"
        className="mt-3 flex-row flex-wrap items-center justify-center gap-x-2 gap-y-2"
      >
        {last.project ? (
          <MutedChip icon="folder" label={last.project} />
        ) : (
          <SkeletonChip width={120} />
        )}
        <View className="flex-row items-center gap-2">
          <Text className="text-[13px] text-muted-foreground">on</Text>
          {last.host ? (
            <MutedChip icon="computer" label={last.host} />
          ) : (
            <SkeletonChip width={96} />
          )}
        </View>
      </View>
      {unreachable ? (
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="mt-3 items-center gap-1"
        >
          <Text className="text-center text-[15px] font-semibold text-foreground">
            {UNREACHABLE_TITLE}
          </Text>
          <Text
            selectable
            className="max-w-xs text-center text-sm text-muted-foreground"
          >
            {unreachableHint(error)}
          </Text>
          <Button
            label="Retry"
            variant="secondary"
            onPress={onRetry}
            style={{ marginTop: 8 }}
            testID="start-retry"
          />
        </View>
      ) : (
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={loading}
          accessibilityLiveRegion="polite"
          className="mt-3 flex-row items-center gap-2"
        >
          <Spinner color={p.muted} />
          <Text className="text-[13px] text-muted-foreground">{loading}</Text>
        </View>
      )}
    </>
  );
}

/** A last pick as a quiet chip: what was picked, until the devices confirm it. */
function MutedChip({
  icon,
  label,
}: {
  icon: 'folder' | 'computer';
  label: string;
}) {
  const p = usePalette();
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      className="h-[30px] max-w-60 flex-row items-center gap-1 rounded-full px-2.5 opacity-60"
      style={{ backgroundColor: p.surfaceMuted }}
    >
      <SymbolImage name={icon} size={13} color={p.muted} />
      <Text
        numberOfLines={1}
        className="shrink text-[13px] font-medium text-muted-foreground"
      >
        {label}
      </Text>
    </View>
  );
}
