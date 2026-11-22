/**
 * The phone app on a running space (docs/mobile.md "Space", "Activity
 * strip") beside the desktop's Devices page (ui/src/ui/fleet/DevicesPage.tsx).
 */
import { Spinner } from '@heroui/react';
import {
  ChevronRight,
  Cloud,
  Display,
  Globe,
  Smartphone,
} from '@gravity-ui/icons';
import { Phone } from '../components/Phone';
import { MockBtn } from '../components/Window';
import { Ring } from '../shared/Ring';

function PhoneApp() {
  return (
    <Phone label="The phone app on a space: its chat, the activity strip, a composer">
      <div className="flex items-center gap-2 px-1 text-[11px] text-muted">
        <span className="text-base leading-none">☰</span>
        <span className="min-w-0 flex-1 truncate text-center">
          <span className="block text-[13px] font-semibold text-foreground">
            Fix the login redirect
          </span>
          on mac-studio · Running · Edit
        </span>
        <span className="text-base leading-none">✎</span>
      </div>
      <div className="mt-4 flex flex-1 flex-col gap-3 overflow-hidden text-[12px]">
        <div className="self-end rounded-2xl bg-surface px-3 py-1.5">
          Also keep the query string.
        </div>
        <p className="leading-snug text-foreground">
          Kept. The return URL now carries its query string through the sign-in.
        </p>
        <div className="flex items-center gap-1.5 text-muted">
          <Spinner size="sm" color="current" className="size-2.5" />
          Edit src/auth/redirect.ts
        </div>
      </div>
      <div className="mt-auto flex flex-col gap-2">
        <div className="rounded-xl border border-separator bg-surface px-3 py-2 text-[11px]">
          <div className="flex items-center gap-1.5">
            <Spinner
              size="sm"
              color="current"
              className="size-2.5 text-muted"
            />
            <span className="min-w-0 flex-1 truncate">2 of 5 · Edit auth</span>
            <span className="tabular-nums text-muted">1m 12s</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-muted">
            <Ring
              color="var(--muted)"
              fill={0.5}
              title="Sub-spaces"
              size={10}
            />
            <span className="min-w-0 flex-1 truncate">
              2 agents · 1 sub-space
            </span>
            <ChevronRight className="size-3 -rotate-90" />
          </div>
        </div>
        <div className="flex flex-col gap-2 rounded-2xl border border-separator bg-surface px-3 pb-2 pt-2.5 text-[11px]">
          <span className="text-muted">Add to the queue…</span>
          <div className="flex items-center">
            <span className="inline-flex h-6 items-center gap-1 rounded-full bg-default px-2">
              Opus 4.1 High
              <ChevronRight className="size-3 rotate-90 text-muted" />
            </span>
            <span className="ms-auto grid size-6 place-items-center rounded-full bg-accent text-accent-foreground">
              ↑
            </span>
          </div>
        </div>
      </div>
    </Phone>
  );
}

const DEVICES: {
  icon: typeof Display;
  name: string;
  kind: string;
  detail: string;
  online: boolean;
  trusted?: boolean;
  extra?: string;
}[] = [
  {
    icon: Display,
    name: 'mac-studio',
    kind: 'This computer',
    detail: 'macOS · up to Run · Claude, Codex',
    online: true,
  },
  {
    icon: Display,
    name: 'linux-box',
    kind: 'Computer',
    detail: 'Linux · up to Edit · Claude',
    online: true,
    trusted: true,
  },
  {
    icon: Smartphone,
    name: 'iPhone',
    kind: 'Phone',
    detail: 'Send my spaces’ questions here · on',
    online: false,
    trusted: true,
  },
  {
    icon: Globe,
    name: 'Safari on iPad',
    kind: 'Web app',
    detail: 'Trusted',
    online: true,
    trusted: true,
  },
  {
    icon: Cloud,
    name: 'Claude (MCP)',
    kind: 'Claude via cloud',
    detail: 'Auto Edit · until 18:00',
    online: true,
    trusted: true,
  },
];

function Devices() {
  return (
    <div
      role="img"
      aria-label="The Devices page: this computer, another computer, a phone, a browser and Claude via cloud, each with its fingerprint, trust and what it may do"
      className="flex flex-col overflow-hidden rounded-2xl border border-separator bg-background text-start shadow-[0_24px_60px_-30px_rgba(0,0,0,0.45)]"
    >
      <div className="flex items-center gap-2 border-b border-separator px-4 py-3">
        <span className="text-sm font-semibold">Devices</span>
        <span className="ms-auto text-xs text-muted">4 of 5 online</span>
      </div>
      <div className="flex flex-col gap-2 p-3">
        <div className="flex flex-col gap-1 rounded-xl border border-separator bg-surface px-3 py-2.5">
          <span className="text-xs text-muted">This device</span>
          <span className="font-mono text-[12px] tracking-wide">
            7f2a 91c0 4e8b 2d17 a6f3 0c59 b8e4 d201
          </span>
          <span className="text-[11px] text-muted">
            Compare this fingerprint on the other device, then trust it there.
          </span>
        </div>
        {DEVICES.map((d) => (
          <div
            key={d.name}
            className="flex items-center gap-3 rounded-xl px-3 py-2 text-[13px]"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-default text-muted">
              <d.icon className="size-4" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-1.5">
                <span className="truncate font-medium">{d.name}</span>
                <span
                  className={`size-1.5 shrink-0 rounded-full ${d.online ? 'bg-success' : 'bg-separator'}`}
                  aria-label={d.online ? 'online' : 'offline'}
                />
                <span className="truncate text-xs text-muted">{d.kind}</span>
              </span>
              <span className="truncate text-xs text-muted">{d.detail}</span>
            </span>
            {d.trusted === true && (
              <span className="hidden shrink-0 items-center gap-1 text-xs text-success sm:inline-flex">
                <Ring color="var(--success)" check title="Trusted" size={12} />
                Trusted
              </span>
            )}
            {d.trusted === undefined && (
              <MockBtn tone="ghost">Fingerprint</MockBtn>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function FleetMock() {
  return (
    <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[236px_minmax(0,1fr)]">
      <PhoneApp />
      <Devices />
    </div>
  );
}
