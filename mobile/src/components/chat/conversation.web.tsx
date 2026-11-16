// Adapted from EvanBacon/chat-template (MIT)
/**
 * The chat's message list on the web: Legend List, centered and at most
 * 768 px wide, padded by the composer under it; a "↓" pill when you scroll
 * up (the browser handles the keyboard).
 */
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import {
  createContext,
  use,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { Pressable, Text, View } from 'react-native';
import { usePalette } from '../../ui/theme';
import { SymbolImage } from '../symbol-image';
import type { ConversationProps } from './types';

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
  const listRef = useRef<LegendListRef>(null);
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
      <View className="relative flex-1 bg-background">
        <LegendList
          ref={listRef}
          data={data}
          renderItem={({ item, index }) => renderItem({ item, index })}
          keyExtractor={keyExtractor}
          estimatedItemSize={96}
          initialScrollAtEnd
          maintainScrollAtEnd
          style={{ flex: 1 }}
          contentContainerStyle={{
            maxWidth: 768,
            width: '100%',
            marginHorizontal: 'auto',
            paddingHorizontal: 16,
            paddingTop: topInset + 24,
            paddingBottom: composerHeight + 16,
          }}
          ListHeaderComponent={header}
          ListFooterComponent={footer}
          ListEmptyComponent={empty}
          onScroll={onScroll}
          scrollEventThrottle={32}
        />
        {children}
      </View>
    </ConversationCtx>
  );
}

export function ConversationScrollButton() {
  const { scrollToBottom, atEnd, composerHeight } = useConversationContext();
  if (atEnd) return null;
  return (
    <Pressable
      onPress={scrollToBottom}
      accessibilityRole="button"
      accessibilityLabel="Scroll to the newest message"
      className="absolute left-1/2 z-10 h-7 -translate-x-1/2 flex-row items-center justify-center rounded-full border border-border/50 bg-card px-3"
      style={{
        bottom: composerHeight + 16,
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
      }}
    >
      <Text className="text-xs leading-none text-muted-foreground">↓</Text>
    </Pressable>
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
    <View className="flex flex-col items-center gap-2 px-4 py-16">
      <SymbolImage name="chat" size={36} color={p.muted} />
      <Text className="text-center text-2xl font-semibold tracking-tight text-foreground">
        {title}
      </Text>
      {description ? (
        <Text className="text-center text-sm text-muted-foreground">
          {description}
        </Text>
      ) : null}
    </View>
  );
}
