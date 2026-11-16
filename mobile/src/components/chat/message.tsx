// Adapted from EvanBacon/chat-template (MIT)
/**
 * One chat message (iOS, Android): yours a bubble on the right, the
 * agent's full width with no bubble.
 *
 * ```text
 *                          ╭───────────────────╮
 *                          │ your message      │   max 80 %, user-bubble
 *                          ╰───────────────────╯
 * the agent's reply, markdown, the whole width
 * ```
 */
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import Animated from 'react-native-reanimated';
import { withUniwind } from 'uniwind';
import { ChatMarkdown } from '../markdown';

const AnimatedView = withUniwind(Animated.View);

export function Message({
  from,
  children,
  dim,
  accessibilityLabel,
}: {
  from: 'user' | 'assistant';
  children: ReactNode;
  /** Undone or queued: drawn faded. */
  dim?: boolean;
  accessibilityLabel?: string;
}) {
  if (from === 'user') {
    return (
      <AnimatedView
        accessibilityLabel={accessibilityLabel}
        className="max-w-[80%] self-end rounded-[20px] bg-user-bubble px-3.5 py-2.5"
        style={{ borderCurve: 'continuous', opacity: dim ? 0.5 : 1 }}
      >
        {typeof children === 'string' ? (
          <Text selectable className="text-base leading-[22px] text-foreground">
            {children}
          </Text>
        ) : (
          children
        )}
      </AnimatedView>
    );
  }
  return (
    <AnimatedView
      accessibilityLabel={accessibilityLabel}
      className="min-w-0 gap-2"
      style={dim ? { opacity: 0.5 } : null}
    >
      {children}
    </AnimatedView>
  );
}

/** An agent's markdown, the template's defaults. */
export function MessageResponse({ children }: { children: string }) {
  return <ChatMarkdown>{children || '...'}</ChatMarkdown>;
}
