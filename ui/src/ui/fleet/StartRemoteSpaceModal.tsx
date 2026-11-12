/** "Run on another device" (docs/fleet.md): pick a device you trust that is
 *  online and takes remote spaces, one of the projects it offers, say what to do
 *  and in which mode (never above what that device allows). */
import { useState, type ReactNode } from 'react';
import { Button, TextArea, ToggleButton } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { SpaceMode } from '../../gen/contract';
import { useRootStore, useUi } from '../../stores/context';
import { Shell } from '../bits';
import {
  MODE_HINT,
  MODE_LABEL,
  capMode,
  modesUpTo,
  startableDevices,
} from './fleet';

/** A labelled row of exclusive choices. */
function Choices({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
        {children}
      </div>
    </div>
  );
}

export const StartRemoteSpaceModal = observer(function StartRemoteSpaceModal() {
  const store = useRootStore();
  const ui = useUi();
  const fleet = store.fleet;
  const devices = startableDevices(fleet.devices);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [mode, setMode] = useState<SpaceMode>('edit');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);

  // The device picked, or the first one; its first project likewise.
  const device = devices.find((d) => d.device_id === deviceId) ?? devices[0];
  const project =
    device?.projects.find((p) => p.id === projectId) ?? device?.projects[0];
  const shownMode = device ? capMode(mode, device.max_mode) : mode;
  const ready = !!device && !!project && goal.trim() !== '' && !busy;

  const start = () => {
    if (!device || !project || !ready) return;
    setBusy(true);
    void fleet
      .start({
        device_id: device.device_id,
        project_id: project.id,
        goal: goal.trim(),
        mode: shownMode,
      })
      .then((space) => {
        ui.closeModal();
        ui.go({ name: 'fleet-space', id: space.space });
      })
      .catch(() => {
        // toasted by api.ts; the form stays to try again
      })
      .finally(() => setBusy(false));
  };

  return (
    <Shell
      title="Run on another device"
      onClose={() => ui.closeModal()}
      footer={
        <>
          <Button variant="ghost" size="sm" onPress={() => ui.closeModal()}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="fleet-start"
            isDisabled={!ready}
            isPending={busy}
            onPress={start}
          >
            Start
          </Button>
        </>
      }
    >
      {devices.length === 0 ? (
        <span className="fleet-none text-sm text-muted">
          No device can take a space right now: it has to be one you trust,
          online, and let trusted devices run spaces.
        </span>
      ) : (
        <>
          <Choices label="Device">
            {devices.map((d) => (
              <ToggleButton
                key={d.device_id}
                size="sm"
                className="fleet-pick-device"
                isSelected={d.device_id === device?.device_id}
                onChange={() => {
                  setDeviceId(d.device_id);
                  setProjectId(null);
                  setMode((m) => capMode(m, d.max_mode));
                }}
              >
                {d.name}
              </ToggleButton>
            ))}
          </Choices>
          <Choices label="Project">
            {(device?.projects ?? []).map((p) => (
              <ToggleButton
                key={p.id}
                size="sm"
                className="fleet-pick-project"
                isSelected={p.id === project?.id}
                onChange={() => setProjectId(p.id)}
              >
                {p.name}
              </ToggleButton>
            ))}
          </Choices>
          <TextArea
            rows={4}
            fullWidth
            autoFocus
            aria-label="Goal"
            placeholder="What should the agent work on?"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
          <Choices label="Mode">
            {device &&
              modesUpTo(device.max_mode).map((m) => (
                <ToggleButton
                  key={m}
                  size="sm"
                  className="fleet-pick-mode"
                  isSelected={m === shownMode}
                  onChange={() => setMode(m)}
                >
                  {MODE_LABEL[m]}
                </ToggleButton>
              ))}
          </Choices>
          <span className="text-xs text-muted">
            {MODE_HINT[shownMode]}
            {device
              ? `. ${device.name} allows up to ${MODE_LABEL[device.max_mode]}.`
              : ''}
          </span>
        </>
      )}
    </Shell>
  );
});
