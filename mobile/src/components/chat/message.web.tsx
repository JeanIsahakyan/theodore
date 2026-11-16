// Adapted from EvanBacon/chat-template (MIT)
/**
 * One chat message on the web: yours a soft bubble on the right, the
 * agent's beside a small "AI" mark, full width.
 */
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { ChatMarkdown } from '../markdown';

export function Message({
  from,
  children,
  dim,
  accessibilityLabel,
}: {
  from: 'user' | 'assistant';
  children: ReactNode;
  dim?: boolean;
  accessibilityLabel?: string;
}) {
  if (from === 'user') {
    return (
      <View
        accessibilityLabel={accessibilityLabel}
        className="flex flex-col items-end gap-2"
        style={dim ? { opacity: 0.5 } : null}
      >
        <View className="max-w-[min(80%,56ch)] overflow-hidden rounded-2xl rounded-br-lg border border-border/30 bg-user-bubble px-3.5 py-2">
          {typeof children === 'string' ? (
            <Text
              selectable
              className="text-[15px] leading-[1.6] text-foreground"
            >
              {children}
            </Text>
          ) : (
            children
          )}
        </View>
      </View>
    );
  }
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      className="flex flex-row items-start gap-3"
      style={dim ? { opacity: 0.5 } : null}
    >
      <View className="flex h-6 shrink-0 items-center">
        <View className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
          <Text className="text-[11px] text-muted-foreground">AI</Text>
        </View>
      </View>
      <View className="flex min-w-0 flex-1 flex-col gap-2">{children}</View>
    </View>
  );
}

export function MessageResponse({ children }: { children: string }) {
  return <ChatMarkdown>{children || '...'}</ChatMarkdown>;
}
