/** The fleet's spot in the tab bar, by the "+" (docs/fleet.md "Auto mode
 *  and remote prompts"): a chip while an auto mode for Claude via cloud is
 *  on, here or on another computer this one knows of, whose popover turns
 *  each off; and "2 waiting" while decisions put away unanswered wait,
 *  which opens their dialog again. Neither covers the page. */
import { useState } from 'react';
import { Bell, Cloud } from '@gravity-ui/icons';
import { Button, Popover, Separator, Tooltip } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { useRootStore, useUi } from '../../stores/context';
import { useNow } from '../space/BackgroundTasks';
import { AUTO_LABEL, untilLabel } from './fleet';
import { promptQueue } from './FleetPrompts';
import {
  CLOUD_CLAUDE,
  CLOUD_KEY_NOTE,
  autoEntries,
  topAuto,
  untilShort,
  type AutoEntry,
} from './prompts';

const CHIP =
  'h-7 min-w-0 shrink-0 gap-1.5 rounded-full border border-warning/30 bg-warning-soft px-2.5 text-xs font-medium text-warning-soft-foreground data-[hovered=true]:bg-warning-soft-hover';

export const FleetChrome = observer(function FleetChrome() {
  const fleet = useRootStore().fleet;
  const nowish = Date.now();
  const timed =
    fleet.confirmList.length > 0 ||
    fleet.autos.some((a) => a.until_ms != null) ||
    fleet.devices.some((d) => (d.mcp_auto ?? []).some((a) => a.until_ms));
  // An auto mode's end or a request's time passing redraws it.
  useNow(fleet.available && timed);
  if (!fleet.available) return null;
  const entries = autoEntries(fleet.autos, fleet.devices, nowish);
  const { queue, open } = promptQueue(fleet, nowish);
  const waiting = open ? 0 : queue.length;
  if (entries.length === 0 && waiting === 0) return null;
  return (
    <div className="fleet-chrome flex min-w-0 shrink-0 items-center gap-1.5">
      {waiting > 0 && (
        <Tooltip>
          <Button
            size="sm"
            variant="ghost"
            className={`fleet-waiting ${CHIP}`}
            aria-label={`${waiting} ${waiting === 1 ? 'decision' : 'decisions'} waiting: show`}
            onPress={() => fleet.reopenPrompts()}
          >
            <Bell className="size-3.5 shrink-0" />
            {waiting} waiting
          </Button>
          <Tooltip.Content>Requests waiting for your decision</Tooltip.Content>
        </Tooltip>
      )}
      {entries.length > 0 && <AutoChip entries={entries} now={nowish} />}
    </div>
  );
});

const AutoChip = observer(function AutoChip({
  entries,
  now,
}: {
  entries: AutoEntry[];
  now: number;
}) {
  const ui = useUi();
  const [open, setOpen] = useState(false);
  const top = topAuto(entries)!;
  const until = untilShort(top.until, now);
  const more = entries.length - 1;
  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant="ghost"
        className={`fleet-auto-chip ${CHIP}`}
        aria-label={`${CLOUD_CLAUDE}: ${AUTO_LABEL[top.auto]} ${untilLabel(top.until, now)}${more > 0 ? `, and ${more} more` : ''}`}
      >
        <Cloud className="size-3.5 shrink-0" />
        <span className="fleet-auto-chip-label truncate">
          {AUTO_LABEL[top.auto]}
          {until && <span className="font-normal"> · {until}</span>}
          {more > 0 && <span className="font-normal"> +{more}</span>}
        </span>
      </Button>
      <Popover.Content placement="bottom end" offset={8} className="w-[360px]">
        <Popover.Dialog className="fleet-auto-pop flex flex-col gap-0 p-0">
          <div className="flex flex-col gap-1 px-4 py-3">
            <Popover.Heading className="text-sm font-semibold">
              Auto mode for {CLOUD_CLAUDE}
            </Popover.Heading>
            <span className="text-xs text-muted">
              It skips your yes for Edit (and, with Full auto, Run) requests.
            </span>
          </div>
          <Separator />
          <ul className="flex flex-col">
            {entries.map((e) => (
              <AutoRow key={e.key} entry={e} now={now} />
            ))}
          </ul>
          <Separator />
          <div className="flex items-center justify-between gap-2 px-4 py-2">
            <span className="text-[11px] text-warning">{CLOUD_KEY_NOTE}</span>
            <Button
              size="sm"
              variant="ghost"
              className="fleet-auto-settings shrink-0 text-xs"
              onPress={() => {
                setOpen(false);
                ui.go({ name: 'settings', page: 'devices' });
              }}
            >
              Settings → Devices
            </Button>
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
});

const AutoRow = observer(function AutoRow({
  entry,
  now,
}: {
  entry: AutoEntry;
  now: number;
}) {
  const fleet = useRootStore().fleet;
  const [busy, setBusy] = useState(false);
  const off = () => {
    setBusy(true);
    void fleet
      .setAuto({
        device_id: entry.deviceId,
        auto: 'off',
        until_ms: null,
        host_device: entry.hostDevice,
      })
      .catch(() => {
        // toasted by api.ts
      })
      .finally(() => setBusy(false));
  };
  return (
    <li
      className="fleet-auto-entry flex items-center gap-3 px-4 py-2.5"
      data-device={entry.deviceId}
      data-host={entry.hostDevice ?? undefined}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{entry.hostName}</span>
        <span className="truncate text-xs text-muted">
          {entry.name}: {AUTO_LABEL[entry.auto]} {untilLabel(entry.until, now)}
        </span>
        {entry.why && (
          <span className="text-[11px] text-muted">{entry.why}</span>
        )}
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="fleet-auto-off shrink-0"
        isDisabled={!entry.canTurnOff}
        isPending={busy}
        onPress={off}
      >
        Turn off
      </Button>
    </li>
  );
});
