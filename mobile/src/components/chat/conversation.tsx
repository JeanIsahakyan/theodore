// Adapted from EvanBacon/chat-template (MIT)
/**
 * The chat's message list (iOS, Android): virtualized (Legend List), it
 * follows the end while you are there, rides on the keyboard with the
 * floating composer, and shows a round "scroll to the end" button when you
 * scroll up.
 *
 * ```text
 * ┌ list ───────────────────────────┐  topInset: room for a glass header
 * │ header · rows · footer           │
 * │                          ( ⌄ )   │  ConversationScrollButton, not at the end
 * │╭ composer (ComposerDock) ──────╮ │  floating; its height ─▶ composerHeight
 * ╰┴───────────────────────────────┴╯
 * end inset = composer + max(safe area, keyboard) + gap
 * ```
 *
 * The keyboard part is Legend List's `KeyboardAwareLegendList`, on
 * react-native-keyboard-controller's `KeyboardChatScrollView` (content
 * insets on iOS, padding on Android): the list's end stays above the
 * keyboard frame by frame, and lifts with it only when you were at the end.
 */
import { BlurViewRawBackdrop } from '../blur-raw';
import type { LegendListRef } from '@legendapp/list/react-native';
import { KeyboardAwareLegendList } from '@legendapp/list/keyboard';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { View } from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { dismissMode } from '../../ui/keyboard';
import { usePalette } from '../../ui/theme';
import { SymbolImage } from '../symbol-image';
import { TouchableGlass } from '../touchable-glass';
import { DOCK_GAP, type ConversationProps } from './types';

const android = process.env.EXPO_OS === 'android';
/** Within this of the end counts as at the end. */
const AT_END = 48;

interface ConversationContextValue {
  scrollToBottom: () => void;
  atEnd: boolean;
  composerHeight: number;
}

const ConversationCtx = createContext<ConversationContextValue | null>(null);

export function useConversationContext() {
  const ctx = use(ConversationCtx);
  if (!ctx)
    throw new Error(
      'useConversationContext must be used within <Conversation>',
    );
  return ctx;
}

export function Conversation<T>({
  ref,
  data,
  renderItem,
  keyExtractor,
  header,
  footer,
  empty,
  composerHeight,
  topInset = 0,
  children,
}: ConversationProps<T>) {
  const insets = useSafeAreaInsets();
  const listRef = useRef<LegendListRef>(null);
  const endInset = useSharedValue(composerHeight + insets.bottom + DOCK_GAP);
  useEffect(() => {
    endInset.value = composerHeight + insets.bottom + DOCK_GAP;
  }, [endInset, composerHeight, insets.bottom]);

  const [atEnd, setAtEnd] = useState(true);
  const atEndRef = useRef(true);
  const onScroll = useCallback(() => {
    const state = listRef.current?.getState();
    if (!state) return;
    const end = state.distanceFromEnd <= AT_END;
    if (end !== atEndRef.current) {
      atEndRef.current = end;
      setAtEnd(end);
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    void listRef.current?.scrollToEnd({ animated: true });
  }, []);
  useImperativeHandle(ref, () => ({ scrollToEnd: scrollToBottom }), [
    scrollToBottom,
  ]);

  return (
    <ConversationCtx value={{ scrollToBottom, atEnd, composerHeight }}>
      <View className="flex-1 bg-background">
        <KeyboardAwareLegendList
          ref={listRef}
          data={data}
          renderItem={({ item, index }) => renderItem({ item, index })}
          keyExtractor={keyExtractor}
          estimatedItemSize={96}
          initialScrollAtEnd
          maintainScrollAtEnd
          contentInsetEndAdjustment={endInset}
          keyboardOffset={insets.bottom}
          keyboardLiftBehavior="whenAtEnd"
          keyboardDismissMode={dismissMode(process.env.EXPO_OS ?? '')}
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustsScrollIndicatorInsets={false}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: topInset + 12,
            paddingBottom: 12,
          }}
          ListHeaderComponent={header}
          ListFooterComponent={footer}
          ListEmptyComponent={empty}
          onScroll={onScroll}
          scrollEventThrottle={32}
          recycleItems={false}
        />
        {topInset > 0 && process.env.EXPO_OS === 'ios' ? (
          // The header floats over the list: the chat scrolls under a blur,
          // never through the title.
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: topInset,
            }}
          >
            <BlurViewRawBackdrop />
          </View>
        ) : null}
        {children}
      </View>
    </ConversationCtx>
  );
}

/** The round button that scrolls back to the newest message. */
export function ConversationScrollButton() {
  const { scrollToBottom, atEnd, composerHeight } = useConversationContext();
  const insets = useSafeAreaInsets();
  const p = usePalette();
  const { height } = useReanimatedKeyboardAnimation();
  const position = useAnimatedStyle(
    () => ({
      bottom:
        composerHeight + Math.max(insets.bottom, -height.value) + DOCK_GAP + 12,
    }),
    process.env.EXPO_OS === 'web' ? [composerHeight, insets.bottom] : undefined,
  );
  if (atEnd) return null;
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[{ position: 'absolute', right: 16 }, position]}
    >
      <TouchableGlass
        onPress={scrollToBottom}
        hitSlop={8}
        accessibilityLabel="Scroll to the newest message"
        // iOS: glass (26+) or blur, untinted; Android: a raised surface.
        className={`h-10 w-10 items-center justify-center rounded-full ${android ? 'bg-card' : ''}`}
        style={android ? { elevation: 3 } : undefined}
      >
        <SymbolImage name="chevron.down" size={16} color={p.muted} />
      </TouchableGlass>
    </Animated.View>
  );
}

export function ConversationEmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}): ReactElement {
  const p = usePalette();
  return (
    <View className="flex-1 items-center justify-center gap-2 py-16">
      <SymbolImage name="chat" size={40} color={p.muted} />
      <Animated.Text
        entering={FadeIn}
        style={{ color: p.text, fontSize: 18, fontWeight: '600' }}
      >
        {title}
      </Animated.Text>
      {description ? (
        <Animated.Text
          entering={FadeIn}
          style={{ color: p.muted, fontSize: 14, textAlign: 'center' }}
        >
          {description}
        </Animated.Text>
      ) : null}
    </View>
  );
}
