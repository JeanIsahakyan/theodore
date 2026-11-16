// Adapted from EvanBacon/chat-template (MIT)
export { ComposerDock } from './composer-dock';
export {
  Conversation,
  ConversationEmptyState,
  ConversationScrollButton,
  useConversationContext,
} from './conversation';
export { Message, MessageResponse } from './message';
export { PromptInput } from './prompt-input';
export { Shimmer, StreamingMessage } from './streaming-message';
export type {
  ComposerDockProps,
  ConversationHandle,
  ConversationProps,
  PromptInputProps,
} from './types';
