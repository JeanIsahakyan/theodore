/**
 * The sharing choice (docs/telemetry.md "The choice"), per install, kept
 * in the app's data storage next to the saved spaces: it belongs to the
 * device, not the account, and survives sign-out.
 *
 * ```text
 * absent            ─▶ no choice yet: nothing is sent, nothing is queued; the card asks
 * usage: true/false ─▶ "Share usage data"      (PostHog)
 * errors: true/false─▶ "Send error reports"    (New Relic through the cloud)
 * *_consent: 2      ─▶ agreed under the current words: the account id may go with it
 * ```
 *
 * The mobile app never had older words, so every "on" here is consent 2;
 * the fields exist so a choice reads the same as the desktop's and a later
 * change of words can ask again.
 */
import { create } from 'zustand';
import type { DataStorage } from '../fleet/data';

export const CONSENT_VERSION = 2;
export const CHOICE_KEY = 'theodore.telemetry.choice';

export interface Choice {
  /** `null`: not chosen yet. */
  usage: boolean | null;
  errors: boolean | null;
  /** The words each switch was agreed under; `null`: off or never on. */
  usageConsent: number | null;
  errorsConsent: number | null;
}

export const NO_CHOICE: Choice = {
  usage: null,
  errors: null,
  usageConsent: null,
  errorsConsent: null,
};

/** A choice is made once either switch has a value. */
export const chosen = (c: Choice): boolean =>
  c.usage !== null || c.errors !== null;

/** "Share usage data" is on and may carry the account id. */
export const linksUsage = (c: Choice): boolean =>
  c.usage === true && (c.usageConsent ?? 0) >= CONSENT_VERSION;

/** "Send error reports" is on and may carry the account id. */
export const linksErrors = (c: Choice): boolean =>
  c.errors === true && (c.errorsConsent ?? 0) >= CONSENT_VERSION;

/**
 * The choice after one or both switches move. Turning a switch on agrees
 * to the current words (consent 2); leaving it on agrees to nothing new;
 * turning it off clears its version.
 */
export function applyChoice(
  before: Choice,
  next: { usage?: boolean; errors?: boolean },
): Choice {
  const out: Choice = { ...before };
  if (next.usage !== undefined) {
    out.usage = next.usage;
    out.usageConsent = next.usage
      ? before.usage
        ? before.usageConsent
        : CONSENT_VERSION
      : null;
  }
  if (next.errors !== undefined) {
    out.errors = next.errors;
    out.errorsConsent = next.errors
      ? before.errors
        ? before.errorsConsent
        : CONSENT_VERSION
      : null;
  }
  // A first choice answers both: what wasn't named is off.
  if (out.usage === null && out.errors !== null) out.usage = false;
  if (out.errors === null && out.usage !== null) out.errors = false;
  return out;
}

export function parseChoice(text: string | null): Choice {
  if (!text) return NO_CHOICE;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return NO_CHOICE;
  }
  if (!v || typeof v !== 'object') return NO_CHOICE;
  const o = v as Record<string, unknown>;
  const bool = (x: unknown): boolean | null => (typeof x === 'boolean' ? x : null);
  const ver = (x: unknown): number | null =>
    typeof x === 'number' && Number.isFinite(x) ? x : null;
  const usage = bool(o.usage);
  const errors = bool(o.errors);
  return {
    usage,
    errors,
    usageConsent: usage ? ver(o.usageConsent) : null,
    errorsConsent: errors ? ver(o.errorsConsent) : null,
  };
}

export const serializeChoice = (c: Choice): string => JSON.stringify(c);

export interface ChoiceState {
  choice: Choice;
  /** The stored choice was read (or there was none). */
  loaded: boolean;
}

/** The choice as screens read it; written only through `consentStore`. */
export const useConsent = create<ChoiceState>(() => ({
  choice: NO_CHOICE,
  loaded: false,
}));

export interface ConsentStore {
  load(): Promise<Choice>;
  /** Records the switches named; resolves with the whole choice. */
  set(next: { usage?: boolean; errors?: boolean }): Promise<Choice>;
  /** Tests: back to no choice. */
  reset(): Promise<void>;
}

export function consentStore(
  storage: DataStorage,
  onChange?: (c: Choice) => void,
): ConsentStore {
  const publish = (c: Choice) => {
    useConsent.setState({ choice: c, loaded: true });
    onChange?.(c);
  };
  return {
    async load() {
      const c = parseChoice(await storage.get(CHOICE_KEY).catch(() => null));
      publish(c);
      return c;
    },
    async set(next) {
      const c = applyChoice(useConsent.getState().choice, next);
      publish(c);
      await storage.set(CHOICE_KEY, serializeChoice(c)).catch(() => {});
      return c;
    },
    async reset() {
      await storage.remove(CHOICE_KEY).catch(() => {});
      useConsent.setState({ choice: NO_CHOICE, loaded: false });
      onChange?.(NO_CHOICE);
    },
  };
}
