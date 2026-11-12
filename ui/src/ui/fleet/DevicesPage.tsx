/** Settings → Devices (docs/fleet.md): connect this device, say what other
 *  devices may do here, and trust the ones that may. Shown only where a
 *  fleet exists (`fleet_status.available`). */
import { useState, type ReactNode } from 'react';
import {
  Button,
  Card,
  Chip,
  Input,
  Separator,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { FleetDevice, SpaceMode } from '../../gen/contract';
import { useRootStore, useUi } from '../../stores/context';
import {
  MODE_HINT,
  MODE_LABEL,
  MODE_ORDER,
  lastSeenLabel,
  startableDevices,
} from './fleet';
import { Fingerprint, TrustConfirm } from './TrustConfirm';

const swallow = () => {
  // toasted by api.ts
};

/** A switch with a title and one line under it. */
function ToggleRow({
  label,
  hint,
  isSelected,
  onChange,
  children,
}: {
  label: string;
  hint: string;
  isSelected: boolean;
  onChange: (v: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-xs text-muted">{hint}</span>
        </div>
        <Switch
          size="sm"
          aria-label={label}
          isSelected={isSelected}
          onChange={onChange}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
      </div>
      {children}
    </div>
  );
}

const ThisDevice = observer(function ThisDevice() {
  const fleet = useRootStore().fleet;
  const status = fleet.status;
  const [draft, setDraft] = useState<string | null>(null);
  if (!status) return null;
  const name = draft ?? status.name;
  const commitName = () => {
    const next = (draft ?? status.name).trim();
    setDraft(null);
    if (!next || next === status.name) return;
    void fleet.setSettings({ name: next }).catch(swallow);
  };
  const state = !status.enabled
    ? { text: 'Not connected', color: 'default' as const }
    : status.connected
      ? { text: 'Connected', color: 'success' as const }
      : { text: 'Connecting…', color: 'warning' as const };
  return (
    <Card variant="secondary" className="fleet-this gap-0 p-0">
      <ToggleRow
        label="Connect this device"
        hint="Joins your devices through your Theodore account, so spaces can be started and answered across them."
        isSelected={status.enabled}
        onChange={(v) => void fleet.setSettings({ enabled: v }).catch(swallow)}
      />
      <Separator />
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <TextField
          value={name}
          onChange={setDraft}
          aria-label="This device's name"
          className="w-56"
        >
          <Input
            className="text-sm"
            onBlur={commitName}
            onKeyDown={(e) => e.key === 'Enter' && commitName()}
          />
        </TextField>
        <Chip
          size="sm"
          variant="soft"
          color={state.color}
          className="fleet-state"
        >
          {state.text}
        </Chip>
        <span className="flex-1" />
        <span className="flex items-center gap-2 text-xs text-muted">
          Fingerprint <Fingerprint value={status.fingerprint} />
        </span>
      </div>
      {status.enabled && !status.connected && status.error && (
        <div role="alert" className="fleet-error px-4 pb-3 text-xs text-danger">
          {status.error}
        </div>
      )}
      <Separator />
      <ToggleRow
        label="Let my trusted devices run spaces here"
        hint="Only devices you trust below. They work in spaces of this computer's projects, with every guard a space has."
        isSelected={status.accept_remote}
        onChange={(v) =>
          void fleet.setSettings({ accept_remote: v }).catch(swallow)
        }
      >
        {status.accept_remote && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted">Highest mode</span>
              <ToggleButtonGroup
                size="sm"
                selectionMode="single"
                disallowEmptySelection
                aria-label="Highest mode"
                selectedKeys={new Set([status.max_mode])}
                onSelectionChange={(keys) => {
                  const v = [...keys][0];
                  if (v) {
                    void fleet
                      .setSettings({ max_mode: String(v) as SpaceMode })
                      .catch(swallow);
                  }
                }}
              >
                {MODE_ORDER.map((m, i) => (
                  <ToggleButton key={m} id={m} className="whitespace-nowrap">
                    {i > 0 && <ToggleButtonGroup.Separator />}
                    {MODE_LABEL[m]}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
              <span className="text-xs text-muted">
                {MODE_HINT[status.max_mode]}
              </span>
            </div>
            {status.max_mode === 'run' && (
              <span
                role="alert"
                className="fleet-run-warning text-xs text-warning"
              >
                Run lets another device have an agent run any command on this
                computer.
              </span>
            )}
          </div>
        )}
      </ToggleRow>
    </Card>
  );
});

const DeviceRow = observer(function DeviceRow({
  device,
  now,
}: {
  device: FleetDevice;
  now: number;
}) {
  const fleet = useRootStore().fleet;
  const [confirm, setConfirm] = useState<'trust' | 'remove' | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (op: () => Promise<void>) => {
    setBusy(true);
    void op()
      .then(() => setConfirm(null))
      .catch(swallow)
      .finally(() => setBusy(false));
  };
  return (
    <div
      className="fleet-device flex flex-col gap-2 border-b border-separator px-4 py-3 last:border-b-0"
      data-device={device.device_id}
    >
      <div className="flex items-center gap-3">
        <span
          aria-label={device.online ? 'Online' : 'Offline'}
          className={`fleet-dot size-2 shrink-0 rounded-full ${device.online ? 'bg-success' : 'bg-muted/50'}`}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2 text-sm font-medium">
            <span className="truncate">{device.name}</span>
            {device.this_device && (
              <Chip size="sm" variant="soft" className="fleet-this-chip">
                This device
              </Chip>
            )}
          </span>
          <span className="text-xs text-muted">
            {device.os === 'macos' ? 'macOS' : 'Linux'} ·{' '}
            {lastSeenLabel(device.last_seen_ms, device.online, now)} ·{' '}
            {device.accepts_remote
              ? `runs spaces up to ${MODE_LABEL[device.max_mode]}`
              : 'does not run remote spaces'}
          </span>
          <span className="text-xs text-muted">
            <Fingerprint value={device.fingerprint} />
          </span>
        </div>
        {!device.this_device && (
          <div className="flex shrink-0 gap-1">
            {device.trusted ? (
              <Button
                size="sm"
                variant="tertiary"
                className="fleet-untrust"
                isPending={busy && confirm === null}
                onPress={() => run(() => fleet.untrust(device.device_id))}
              >
                Untrust
              </Button>
            ) : (
              <Button
                size="sm"
                variant="tertiary"
                className="fleet-trust"
                isDisabled={confirm !== null}
                onPress={() => setConfirm('trust')}
              >
                Trust
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="fleet-remove"
              isDisabled={confirm !== null || device.online}
              aria-describedby={
                device.online
                  ? `fleet-remove-why-${device.device_id}`
                  : undefined
              }
              onPress={() => setConfirm('remove')}
            >
              Remove
            </Button>
          </div>
        )}
      </div>
      {!device.this_device && device.online && (
        <span
          id={`fleet-remove-why-${device.device_id}`}
          className="fleet-remove-why text-xs text-muted"
        >
          Only an offline device can be removed: quit Theodore on it, or turn
          its fleet off, first.
        </span>
      )}
      {confirm === 'trust' && (
        <TrustConfirm
          deviceId={device.device_id}
          name={device.name}
          fingerprint={device.fingerprint}
          publicKey={device.public_key}
          onCancel={() => setConfirm(null)}
          onTrusted={() => setConfirm(null)}
        />
      )}
      {confirm === 'remove' && (
        <div
          role="alertdialog"
          aria-label={`Remove ${device.name}`}
          className="fleet-remove-confirm flex flex-col gap-2 rounded-lg border border-danger/40 p-3"
        >
          <span className="text-sm">
            Remove <span className="font-medium">{device.name}</span>? It leaves
            the fleet and has to join again as a new device.
          </span>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="fleet-remove-cancel"
              onPress={() => setConfirm(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              className="fleet-remove-confirm-button"
              isPending={busy}
              onPress={() => run(() => fleet.remove(device.device_id))}
            >
              Remove {device.name}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
});

export const DevicesPage = observer(function DevicesPage() {
  const fleet = useRootStore().fleet;
  const ui = useUi();
  if (!fleet.available) return null;
  const now = Date.now();
  const canStart = startableDevices(fleet.devices).length > 0;
  return (
    <>
      <section className="flex flex-col gap-2">
        <Typography.Heading level={6}>This device</Typography.Heading>
        <ThisDevice />
      </section>
      <Separator />
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Typography.Heading level={6} className="flex-1">
            Your devices
          </Typography.Heading>
          <Button
            size="sm"
            variant="tertiary"
            className="fleet-run-elsewhere"
            isDisabled={!canStart}
            onPress={() => ui.openModal('fleet-start')}
          >
            Run on another device…
          </Button>
        </div>
        <Card variant="secondary" className="fleet-devices gap-0 p-0">
          {fleet.devices.length === 0 ? (
            <span className="px-4 py-3 text-xs text-muted">
              No devices yet. Connect this one, then open Theodore on another
              computer signed in to the same account.
            </span>
          ) : (
            fleet.devices.map((d) => (
              <DeviceRow key={d.device_id} device={d} now={now} />
            ))
          )}
        </Card>
        {!canStart && fleet.devices.length > 0 && (
          <span className="text-xs text-muted">
            A space can start on a device you trust that is online and lets
            trusted devices run spaces.
          </span>
        )}
      </section>
    </>
  );
});
