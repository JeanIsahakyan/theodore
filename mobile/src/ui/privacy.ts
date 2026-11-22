/**
 * The sharing choice's words, the same as the desktop's (ui/src/ui/Privacy.tsx,
 * docs/telemetry.md "The choice"), with no React Native so they are tested
 * and the same on iOS, Android and web.
 */
import type { Choice } from '../telemetry/consent';

export type ShareKind = 'usage' | 'errors';

export const SHARE_TITLE = 'Help improve Theodore';

/** The one claim the UI makes about what is shared, everywhere it's shown. */
export const TELEMETRY_CLAIM =
  "Linked to your Theodore account's id when you're signed in, never to your email, name or messages; project and computer names are hashed; you can turn this off any time in Settings.";

export const SHARE_ROWS: readonly {
  kind: ShareKind;
  label: string;
  hint: string;
}[] = [
  {
    kind: 'usage',
    label: 'Share usage data',
    hint: "Which features are used, counts and timings, with your Theodore account's id when you're signed in. No messages, code, paths, titles, email or name.",
  },
  {
    kind: 'errors',
    label: 'Send error reports',
    hint: "Warnings, errors and crash reports, with your Theodore account's id when you're signed in. Tokens and emails are removed; project and computer names are hashed.",
  },
];

export const WHATS_COLLECTED = "What's collected";
export const NOT_CONFIGURED = 'Not configured in this build';

/** What the card records for Save / Don't share: only the available
 *  switches may be on; both are answered. */
export function cardChoice(
  picked: { usage: boolean; errors: boolean },
  available: { usage: boolean; errors: boolean },
): { usage: boolean; errors: boolean } {
  return {
    usage: available.usage && picked.usage,
    errors: available.errors && picked.errors,
  };
}

/** The card shows while a sink can send and no choice is recorded. */
export function needsSharingChoice(
  choice: Choice,
  available: { usage: boolean; errors: boolean },
  loaded: boolean,
): boolean {
  if (!loaded) return false;
  return (
    (available.usage && choice.usage === null) ||
    (available.errors && choice.errors === null)
  );
}

/** A Settings switch's shown value: off until chosen, off when unavailable. */
export const switchValue = (
  choice: Choice,
  kind: ShareKind,
  available: boolean,
): boolean => available && choice[kind] === true;
