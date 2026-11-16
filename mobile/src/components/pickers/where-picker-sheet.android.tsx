/**
 * Android: the where sheet's content in Compose (inside the chip's
 * `ModalBottomSheet`); the same steps as `where-picker-list.tsx`: devices
 * with an online dot ─▶ a device's projects.
 */
import { Column, Icon, IconButton } from '@expo/ui/jetpack-compose';
import {
  fillMaxWidth,
  padding,
  semantics,
  verticalScroll,
} from '@expo/ui/jetpack-compose/modifiers';
import { useState } from 'react';
import { applyWhere } from '../../state/compose';
import { usePalette } from '../../ui/theme';
import { tick } from './haptics';
import { SheetRow, SheetTitle } from './sheet-parts.android';
import { useDeviceRows, useHome } from './use-picker';
import { firstStep } from './where-steps';

const BACK = require('../../../assets/icons/arrow_back.xml');

export function WherePickerSheet({ onClose }: { onClose: () => void }) {
  const p = usePalette();
  const rows = useDeviceRows();
  const shown = useHome();
  const [step, setStep] = useState<string | null>(() => firstStep(rows));
  const open = step ? rows.find((r) => r.device.deviceId === step) : null;
  const pickProject = (deviceId: string, projectId: string) => {
    applyWhere(deviceId, projectId);
    tick();
    onClose();
  };
  const several = rows.filter((r) => r.enabled).length > 1;

  return (
    <Column
      modifiers={[fillMaxWidth(), verticalScroll(), padding(0, 0, 0, 24)]}
    >
      {open ? (
        <>
          <SheetTitle
            leading={
              several ? (
                <IconButton
                  onClick={() => setStep(null)}
                  modifiers={[semantics({ contentDescription: 'Devices' })]}
                >
                  <Icon source={BACK} size={24} tint={p.text} />
                </IconButton>
              ) : undefined
            }
          >
            {`Runs on ${open.device.name}`}
          </SheetTitle>
          {open.device.projects.map((x) => (
            <SheetRow
              key={x.id}
              label={x.name}
              selected={
                shown.device?.deviceId === open.device.deviceId &&
                shown.project?.id === x.id
              }
              onPress={() => pickProject(open.device.deviceId, x.id)}
            />
          ))}
        </>
      ) : (
        <>
          <SheetTitle>Runs on</SheetTitle>
          {rows.map((r) => {
            const d = r.device;
            const one = d.projects.length === 1 ? d.projects[0] : null;
            return (
              <SheetRow
                key={d.deviceId}
                label={d.name}
                detail={r.detail}
                dot={d.online ? 'on' : 'off'}
                disabled={!r.enabled}
                chevron={r.enabled && !one}
                selected={!!one && shown.device?.deviceId === d.deviceId}
                accessibilityLabel={`${d.name}, ${d.online ? 'online' : 'offline'}, ${r.detail}`}
                onPress={() => {
                  if (one) pickProject(d.deviceId, one.id);
                  else setStep(d.deviceId);
                }}
              />
            );
          })}
        </>
      )}
    </Column>
  );
}
