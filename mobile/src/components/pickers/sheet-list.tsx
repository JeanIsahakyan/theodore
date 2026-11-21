/** A sheet's React Native content by kind (iOS routes, the web modal). */
import { ModelPickerList } from './model-picker-list';
import type { SheetKind } from './types';
import { ComputerPickerList, ProjectPickerList } from './where-picker-list';

export function SheetList({
  kind,
  space,
  onClose,
}: {
  kind: SheetKind;
  space?: string | null;
  onClose: () => void;
}) {
  if (kind === 'model')
    return <ModelPickerList space={space ?? null} onClose={onClose} />;
  if (kind === 'computer') return <ComputerPickerList onClose={onClose} />;
  return <ProjectPickerList onClose={onClose} />;
}
