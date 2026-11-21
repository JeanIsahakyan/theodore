// Adapted from EvanBacon/chat-template (MIT)
/**
 * The composer on iOS and Android (props: `./types.ts`).
 *
 * | | Surface | Send |
 * | --- | --- | --- |
 * | iOS 26+ | Liquid Glass, interactive | foreground circle, SF arrow |
 * | iOS < 26 | system chrome blur | same |
 * | Android | Material 3 `surfaceContainerHigh`, 28 dp corners | filled icon button (`primary`) |
 *
 * Send is pressable only when allowed; while `running` it is Stop. A light
 * haptic on send and stop.
 */
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { usePalette } from '../../ui/theme';
import { SymbolImage } from '../symbol-image';
import type { PromptInputProps } from './types';

const GLASS = isLiquidGlassAvailable();
const android = process.env.EXPO_OS === 'android';
const RADIUS = android ? 28 : 24;

function Surface({ children }: { children: ReactNode }) {
  const style = {
    borderRadius: RADIUS,
    borderCurve: 'continuous' as const,
    overflow: 'hidden' as const,
  };
  if (GLASS)
    return (
      <GlassView isInteractive glassEffectStyle="regular" style={style}>
        {children}
      </GlassView>
    );
  if (android)
    return (
      <View className="bg-muted" style={style}>
        {children}
      </View>
    );
  return (
    <BlurView tint="systemChromeMaterial" style={style}>
      {children}
    </BlurView>
  );
}

function PromptInputError({ message }: { message: string }) {
  return (
    <Animated.View className="px-1 pb-2">
      <View
        className="flex-row items-center gap-2 rounded-xl bg-card px-3 py-2.5"
        style={{ borderCurve: 'continuous' }}
      >
        <View className="h-2 w-2 rounded-full bg-danger" />
        <Text
          selectable
          className="flex-1 text-xs text-muted-foreground"
          numberOfLines={3}
        >
          {message}
        </Text>
      </View>
    </Animated.View>
  );
}

function SubmitButton({
  mode,
  enabled,
  label,
  onPress,
}: {
  mode: 'send' | 'stop' | 'busy';
  enabled: boolean;
  label: string;
  onPress: () => void;
}) {
  const p = usePalette();
  // Android: Material 3 filled icon button (40 dp, primary / onPrimary).
  const on = android ? 'bg-primary' : 'bg-foreground';
  const ink = enabled ? (android ? p.onAccent : p.background) : p.muted;
  const size = android ? 40 : 34;
  return (
    <Pressable
      onPress={onPress}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled, busy: mode === 'busy' }}
      hitSlop={6}
      android_ripple={{ borderless: true, radius: size / 2 }}
      className={`items-center justify-center rounded-full active:opacity-70 ${enabled || mode === 'busy' ? on : 'bg-secondary'}`}
      style={{ width: size, height: size }}
    >
      {mode === 'busy' ? (
        <Animated.View>
          <ActivityIndicator
            size="small"
            color={android ? p.onAccent : p.background}
          />
        </Animated.View>
      ) : (
        <SymbolImage
          name={mode === 'stop' ? 'stop' : 'arrow.up'}
          size={mode === 'stop' ? 14 : 18}
          weight="semibold"
          color={ink}
        />
      )}
    </Pressable>
  );
}

export function PromptInput({
  value,
  onChangeText,
  onSubmit,
  placeholder = 'Message',
  disabled,
  editable,
  sending,
  running,
  onStop,
  stopping,
  canSubmit,
  header,
  leading,
  trailing,
  error,
  autoFocus,
  maxLength = 20_000,
  submitLabel = 'Send',
  inputRef,
  testID,
}: PromptInputProps) {
  const p = usePalette();
  const sendable = (canSubmit ?? value.trim() !== '') && !disabled && !sending;
  const stopMode = !!running && !!onStop;
  const mode =
    sending || (stopMode && stopping) ? 'busy' : stopMode ? 'stop' : 'send';
  const enabled = mode === 'stop' ? !disabled : mode === 'send' && sendable;

  const press = () => {
    if (!enabled) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (mode === 'stop') onStop?.();
    else onSubmit();
  };

  return (
    <View testID={testID}>
      {error ? <PromptInputError message={error} /> : null}
      <Surface>
        {header ? (
          <View className="border-b border-border/60">{header}</View>
        ) : null}
        <TextInput
          ref={inputRef}
          nativeID="composer"
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={p.muted}
          accessibilityLabel={placeholder}
          editable={editable ?? !disabled}
          autoFocus={autoFocus}
          maxLength={maxLength}
          multiline
          cursorColor={p.accent}
          selectionColor={p.accent}
          className="max-h-36 min-h-12 px-4 pt-3.5 pb-1 text-foreground"
          style={{ fontSize: android ? 16 : 17 }}
        />
        <View className="min-h-12 flex-row items-center gap-2 pr-2 pb-2 pl-2">
          {/* Chips scroll sideways when they don't fit. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            className="flex-1"
            contentContainerClassName="items-center gap-2"
          >
            {leading}
          </ScrollView>
          {trailing}
          <SubmitButton
            mode={mode}
            enabled={enabled}
            label={mode === 'stop' ? 'Stop' : submitLabel}
            onPress={press}
          />
        </View>
      </Surface>
    </View>
  );
}
