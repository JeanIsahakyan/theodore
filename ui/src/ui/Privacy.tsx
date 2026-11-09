/** Settings → About & updates → Privacy: the two sharing switches. Each
 *  gates its own sink; a choice still unmade shows as off, and changing
 *  either records both. Turning one on agrees to the words beside it (the
 *  core records that); leaving one on doesn't. */
import { useEffect, useState } from 'react';
import { Card, Switch } from '@heroui/react';
import type { TelemetryChoice, TelemetryStatus } from '../gen/contract';
import { api } from '../core/api';
import { useUi } from '../stores/context';
import { Spinner } from './bits';

export type TelemetryKind = 'usage' | 'errors';

/** The choice to record when one switch flips: the other keeps its
 *  current value, or off when nothing was chosen yet. */
export function nextChoice(
  status: Pick<TelemetryStatus, 'usage' | 'errors'>,
  kind: TelemetryKind,
  value: boolean,
): TelemetryChoice {
  return {
    usage: kind === 'usage' ? value : (status.usage ?? false),
    errors: kind === 'errors' ? value : (status.errors ?? false),
  };
}

/** The two choices, worded the same in Settings and onboarding. */
export const SHARE_ROWS: {
  kind: TelemetryKind;
  label: string;
  hint: string;
}[] = [
  {
    kind: 'usage',
    label: 'Share usage data',
    hint: "Which features are used, counts and timings, with your Theodore account's id when you're signed in. No code, paths, titles, comment text, email or name.",
  },
  {
    kind: 'errors',
    label: 'Send error reports',
    hint: "Warnings, errors and crash reports, with your Theodore account's id when you're signed in. Tokens and emails are removed; repository names and paths are hashed.",
  },
];

/** "What's collected" — the same link in Settings and onboarding. */
export function WhatsCollectedLink() {
  const ui = useUi();
  return (
    <button
      type="button"
      className="whats-collected-link self-start text-sm text-accent hover:underline"
      onClick={() => ui.openModal('whats-collected')}
    >
      What's collected
    </button>
  );
}

export function PrivacyCard() {
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api.telemetryStatus().then(
      (s) => live && setStatus(s),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);

  const toggle = (kind: TelemetryKind, value: boolean) => {
    if (!status) return;
    const before = status;
    const req = nextChoice(status, kind, value);
    // Shown at once; the core's answer replaces it, a failure rolls back
    // (and is toasted by api.ts).
    setStatus({ ...status, ...req });
    api.setTelemetry(req).then(setStatus, () => setStatus(before));
  };

  return (
    <Card variant="secondary" className="privacy flex flex-col gap-3 p-4">
      <span className="text-sm font-medium">Privacy</span>
      {failed ? (
        <span className="text-sm text-muted">
          Couldn't read the sharing settings.
        </span>
      ) : !status ? (
        <Spinner />
      ) : (
        <>
          {SHARE_ROWS.map(({ kind, label, hint }) => {
            const available =
              kind === 'usage'
                ? status.usage_available
                : status.errors_available;
            return (
              <div key={kind} className={`privacy-${kind} flex gap-3`}>
                <Switch
                  size="sm"
                  aria-label={label}
                  isSelected={available && (status[kind] ?? false)}
                  isDisabled={!available}
                  onChange={(v) => toggle(kind, v)}
                >
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch.Content>
                </Switch>
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm">{label}</span>
                  <span className="text-xs text-muted">{hint}</span>
                  {!available && (
                    <span className="text-xs text-muted italic">
                      Not configured in this build
                    </span>
                  )}
                  {available &&
                    (kind === 'usage'
                      ? status.usage_needs_consent
                      : status.errors_needs_consent) && (
                      <span className="text-xs text-muted italic">
                        Anonymous for now: you'll be asked about linking it to
                        your account.
                      </span>
                    )}
                </div>
              </div>
            );
          })}
          <WhatsCollectedLink />
        </>
      )}
    </Card>
  );
}
