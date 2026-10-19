/** Settings → Sandbox (listed only in sandbox mode): the scenario this window
 *  runs, its injectable faults, and its scripted timeline — the same controls
 *  `theodore sandbox` offers from a terminal. */
import { useEffect, useRef, useState } from 'react';
import { Thunderbolt } from '@gravity-ui/icons';
import { Button, Card, Chip, Switch, Typography } from '@heroui/react';
import type { SandboxStatus } from '../../gen/contract';
import { api } from '../../core/api';
import { Spinner } from '../bits';
import { SANDBOX_POLL_MS, formatDue, latestOnly } from './sandbox';

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-4 border-b border-separator px-4 py-2.5 last:border-b-0">
      <span className="w-28 shrink-0 text-sm text-muted">{label}</span>
      <span className="min-w-0 flex-1 select-text break-all font-mono text-xs">
        {value}
      </span>
    </div>
  );
}

export function SandboxPage() {
  const [status, setStatus] = useState<SandboxStatus | null | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | null>(null);
  /** Fault name or event id with a request in flight. */
  const [busy, setBusy] = useState<string | null>(null);
  const order = useRef(latestOnly());

  /** Every reply goes through here, so a slow poll never undoes a toggle. */
  const apply = (req: Promise<SandboxStatus | null>) => {
    const ticket = order.current.next();
    return req.then((s) => {
      if (order.current.accept(ticket)) setStatus(s);
    });
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      const ticket = order.current.next();
      api
        .sandboxStatus()
        .then((s) => {
          if (cancelled) return;
          if (order.current.accept(ticket)) setStatus(s);
          setError(null);
          // Outside sandbox mode there's nothing to follow.
          if (s) timer = setTimeout(poll, SANDBOX_POLL_MS);
        })
        .catch((e: unknown) => {
          // Already toasted once by `api.ts`; stop instead of toasting
          // every two seconds.
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        });
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const run = (key: string, req: () => Promise<SandboxStatus>) => {
    setBusy(key);
    void apply(req())
      .catch(() => {
        // Toasted by `api.ts`; the next poll shows the real state.
      })
      .finally(() => setBusy(null));
  };

  if (status === undefined) {
    return error ? (
      <span className="text-sm text-danger">{error}</span>
    ) : (
      <Spinner />
    );
  }
  if (status === null) {
    return (
      <span className="text-sm text-muted">
        This window isn't running in sandbox mode.
      </span>
    );
  }

  return (
    <>
      <section className="sandbox-info flex flex-col gap-2">
        <Typography.Heading level={6}>Scenario</Typography.Heading>
        <Card variant="secondary" className="gap-0 p-0">
          <InfoRow label="Scenario" value={status.info.scenario} />
          <InfoRow label="Signed in as" value={status.viewer} />
          <InfoRow label="Pull requests" value={String(status.prs)} />
          <InfoRow label="Data dir" value={status.info.data_dir} />
          <InfoRow label="Scenario dir" value={status.info.scenario_dir} />
        </Card>
        {error && <span className="text-xs text-danger">{error}</span>}
      </section>

      <section className="sandbox-faults flex flex-col gap-2">
        <Typography.Heading level={6}>Faults</Typography.Heading>
        {status.faults.length === 0 ? (
          <span className="text-sm text-muted">
            This scenario defines no faults.
          </span>
        ) : (
          <Card variant="secondary" className="gap-0 p-0">
            {status.faults.map((f) => (
              <div
                key={f.name}
                className="set-row flex items-center gap-4 border-b border-separator px-4 py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-mono text-sm font-medium">
                    {f.name}
                  </span>
                  <span className="text-xs text-muted">{f.detail}</span>
                </div>
                <Switch
                  size="sm"
                  aria-label={`${f.name} fault`}
                  isSelected={f.on}
                  isDisabled={busy === `fault:${f.name}`}
                  onChange={(on) =>
                    run(`fault:${f.name}`, () =>
                      api.sandboxSetFault({ name: f.name, on }),
                    )
                  }
                >
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch.Content>
                </Switch>
              </div>
            ))}
          </Card>
        )}
      </section>

      <section className="sandbox-events flex flex-col gap-2">
        <Typography.Heading level={6}>Timeline</Typography.Heading>
        {status.events.length === 0 ? (
          <span className="text-sm text-muted">
            This scenario has no scripted events.
          </span>
        ) : (
          <Card variant="secondary" className="gap-0 p-0">
            {status.events.map((ev) => (
              <div
                key={ev.id}
                className="set-row flex items-center gap-4 border-b border-separator px-4 py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium">{ev.label}</span>
                  <span className="font-mono text-xs text-muted">
                    {ev.id} · {formatDue(ev.at_ms)}
                  </span>
                </div>
                {ev.fired && (
                  <Chip size="sm" variant="soft" color="success">
                    fired
                  </Chip>
                )}
                <Button
                  size="sm"
                  variant="tertiary"
                  className="gap-1.5"
                  isPending={busy === `event:${ev.id}`}
                  onPress={() =>
                    run(`event:${ev.id}`, () => api.sandboxFireEvent(ev.id))
                  }
                >
                  <Thunderbolt className="size-3.5" />
                  Fire now
                </Button>
              </div>
            ))}
          </Card>
        )}
      </section>

      <span className="text-xs text-muted">
        <code className="font-mono">theodore sandbox --help</code> drives the
        same controls from a terminal.
      </span>
    </>
  );
}
