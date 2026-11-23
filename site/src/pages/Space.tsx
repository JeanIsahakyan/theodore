/**
 * `/s/<id>`: opens a space in Theodore on whatever the visitor is on
 * (docs/website.md "Space links"; the logic in `src/space/open.ts`). One
 * prerendered shell serves every id (Pages rewrites `/s/*` to it): the
 * server renders the waiting state only, and the browser adds what its
 * platform gets after it mounts, so hydration matches.
 */
import { useEffect, useState } from 'react';
import { ButtonLink, Container } from '../components/ui';
import { detectInBrowser } from '../download/platform';
import {
  DOWNLOAD,
  SHOW_BUTTONS_AFTER_MS,
  channelFor,
  planFor,
  spaceIdFromPath,
  type OpenPlan,
} from '../space/open';

type State =
  | { kind: 'waiting' }
  | { kind: 'bad-link' }
  | { kind: 'opening'; plan: OpenPlan; buttons: boolean };

/** What the browser can do with the link, once it runs. */
function useOpenState(): State {
  const [state, setState] = useState<State>({ kind: 'waiting' });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    void detectInBrowser().then((platform) => {
      if (!live) return;
      const id = spaceIdFromPath(window.location.pathname);
      if (!id) {
        setState({ kind: 'bad-link' });
        return;
      }
      const plan = planFor(id, platform, channelFor(window.location.hostname));
      if (plan.autoOpen) {
        setState({ kind: 'opening', plan, buttons: false });
        // The scheme hands the link to the desktop app when it is
        // installed; a browser without a handler shows a dialog or
        // nothing. Either way the page stays, and the buttons follow.
        window.location.href = plan.autoOpen;
        timer = setTimeout(() => {
          if (live) setState({ kind: 'opening', plan, buttons: true });
        }, SHOW_BUTTONS_AFTER_MS);
      } else {
        setState({ kind: 'opening', plan, buttons: true });
      }
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return state;
}

export function Space() {
  const state = useOpenState();
  if (state.kind === 'bad-link') {
    return (
      <div className="py-24">
        <Container className="flex flex-col items-start gap-5">
          <h1 className="text-4xl font-semibold tracking-tight">
            This isn't a space link
          </h1>
          <p className="text-muted">
            A space link looks like theodore.cloud/s/ followed by the space's
            id. Check the link you were given.
          </p>
          <ButtonLink href={DOWNLOAD} tone="primary">
            Download Theodore
          </ButtonLink>
        </Container>
      </div>
    );
  }
  const buttons = state.kind === 'opening' && state.buttons ? state.plan : null;
  return (
    <div className="py-24">
      <Container className="flex flex-col items-start gap-5">
        <h1 className="text-4xl font-semibold tracking-tight">
          Opening this space in Theodore…
        </h1>
        <p className="max-w-2xl text-muted">
          This page carries only the space's id and shows nothing of the space.
          Only devices signed in to your organization and trusted by your
          computer can open it.
        </p>
        {buttons && (
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Open the space"
          >
            {buttons.buttons.map((b) => (
              <ButtonLink key={b.label} href={b.href} tone={b.tone}>
                {b.label}
              </ButtonLink>
            ))}
          </div>
        )}
        {buttons?.target === 'desktop' && (
          <p className="text-sm text-muted">
            Nothing happened? Theodore isn't installed on this computer, or this
            space runs on another one. The web app follows the spaces on every
            computer you trust.
          </p>
        )}
        {buttons?.target === 'phone' && (
          <p className="text-sm text-muted">
            With Theodore Code installed, this link opens the app directly.
          </p>
        )}
      </Container>
    </div>
  );
}
