/** Auto mode for Claude via cloud (docs/fleet.md "Auto mode and remote
 *  prompts"): Off / Auto Edit / Full auto on this computer, or on another
 *  one you trust (`hostDevice`). Turning it on asks how long first. */
import { useState } from 'react';
import { Button, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { FleetAuto } from '../../gen/contract';
import { useRootStore } from '../../stores/context';
import {
  AUTO_DURATIONS,
  AUTO_LABEL,
  AUTO_ORDER,
  autoOn,
  autoUntil,
  autoWarning,
  untilLabel,
  type AutoDuration,
} from './fleet';

const swallow = () => {
  // toasted by api.ts
};

export const AutoControl = observer(function AutoControl({
  deviceId,
  hostDevice = null,
  auto,
  until,
  label = 'Auto mode',
  isDisabled = false,
}: {
  /** The Claude via cloud device. */
  deviceId: string;
  /** Another computer whose auto mode this is; `null`: this one. */
  hostDevice?: string | null;
  auto: FleetAuto | undefined;
  until: number | null | undefined;
  label?: string;
  isDisabled?: boolean;
}) {
  const fleet = useRootStore().fleet;
  const [pick, setPick] = useState<FleetAuto | null>(null);
  const [busy, setBusy] = useState(false);
  const now = Date.now();
  const current: FleetAuto = autoOn(auto, until, now) ? auto! : 'off';
  const send = (next: FleetAuto, untilMs: number | null) => {
    setBusy(true);
    void fleet
      .setAuto({
        device_id: deviceId,
        auto: next,
        until_ms: untilMs,
        host_device: hostDevice,
      })
      .then(() => setPick(null))
      .catch(swallow)
      .finally(() => setBusy(false));
  };
  const choose = (d: AutoDuration) => {
    if (pick) send(pick, autoUntil(d, Date.now()));
  };
  const shown = pick ?? current;
  return (
    <div
      className="fleet-auto flex flex-col gap-1.5"
      data-device={deviceId}
      data-host={hostDevice ?? undefined}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-muted">{label}</span>
        <ToggleButtonGroup
          size="sm"
          selectionMode="single"
          disallowEmptySelection
          aria-label={label}
          isDisabled={isDisabled || busy}
          selectedKeys={new Set([shown])}
          onSelectionChange={(keys) => {
            const v = String([...keys][0] ?? '') as FleetAuto;
            if (!v || v === shown) return;
            if (v === 'off') {
              setPick(null);
              if (current !== 'off') send('off', null);
              return;
            }
            setPick(v);
          }}
        >
          {AUTO_ORDER.map((a, i) => (
            <ToggleButton key={a} id={a} className="whitespace-nowrap">
              {i > 0 && <ToggleButtonGroup.Separator />}
              {AUTO_LABEL[a]}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        {current !== 'off' && !pick && (
          <span className="fleet-auto-until text-xs text-muted">
            {AUTO_LABEL[current]} {untilLabel(until, now)}
          </span>
        )}
      </div>
      {pick && (
        <div
          role="group"
          aria-label="How long"
          className="fleet-auto-duration flex flex-wrap items-center gap-2"
        >
          <span className="text-xs text-muted">{AUTO_LABEL[pick]} for</span>
          {AUTO_DURATIONS.map((d) => (
            <Button
              key={d.id}
              size="sm"
              variant="tertiary"
              className={`fleet-auto-for-${d.id}`}
              isDisabled={busy}
              onPress={() => choose(d.id)}
            >
              {d.label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            className="fleet-auto-cancel"
            isDisabled={busy}
            onPress={() => setPick(null)}
          >
            Cancel
          </Button>
        </div>
      )}
      {shown !== 'off' && (
        <span role="alert" className="fleet-auto-warning text-xs text-warning">
          {autoWarning(shown)}
        </span>
      )}
    </div>
  );
});
