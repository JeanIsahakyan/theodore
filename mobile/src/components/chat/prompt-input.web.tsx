// Adapted from EvanBacon/chat-template (MIT)
/**
 * The composer on web (props: `./types.ts`): a card with a soft shadow,
 * the field over a footer row of chips and the send button. Enter sends,
 * Shift+Enter is a newline.
 */
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextInputKeyPressEvent,
} from 'react-native';
import { usePalette } from '../../ui/theme';
import { SymbolImage } from '../symbol-image';
import type { PromptInputProps } from './types';

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
  const busy = !!sending || (stopMode && !!stopping);
  const enabled = busy ? false : stopMode ? !disabled : sendable;

  const press = () => {
    if (!enabled) return;
    if (stopMode) onStop?.();
    else onSubmit();
  };

  const onKeyPress = (e: TextInputKeyPressEvent) => {
    const ev = e.nativeEvent as TextInputKeyPressEvent['nativeEvent'] & {
      shiftKey?: boolean;
      isComposing?: boolean;
    };
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      e.preventDefault();
      if (!stopMode) press();
    }
  };

  return (
    <View testID={testID} className="w-full gap-2">
      {error ? (
        <View className="flex-row items-center gap-2 rounded-xl bg-card px-3 py-2.5">
          <View className="h-2 w-2 rounded-full bg-danger" />
          <Text selectable className="flex-1 text-xs text-muted-foreground">
            {error}
          </Text>
        </View>
      ) : null}
      <View
        className="w-full rounded-2xl border border-border bg-card"
        style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}
      >
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
          onKeyPress={onKeyPress}
          className="min-h-20 w-full bg-transparent px-4 pt-3.5 pb-1.5 text-[15px] leading-relaxed text-foreground"
          style={
            { maxHeight: 200, resize: 'none', outlineStyle: 'none' } as object
          }
        />
        <View className="flex-row items-center gap-2 px-3 pb-3">
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
          <Pressable
            onPress={press}
            disabled={!enabled}
            accessibilityRole="button"
            accessibilityLabel={stopMode ? 'Stop' : submitLabel}
            accessibilityState={{ disabled: !enabled, busy }}
            className={`h-8 w-8 items-center justify-center rounded-xl ${enabled || busy ? 'bg-foreground hover:opacity-85' : 'bg-muted'}`}
          >
            {busy ? (
              <ActivityIndicator size="small" color={p.background} />
            ) : (
              <SymbolImage
                name={stopMode ? 'stop' : 'arrow.up'}
                size={stopMode ? 12 : 16}
                color={enabled ? p.background : p.muted}
              />
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}
