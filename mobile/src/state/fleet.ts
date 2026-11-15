/**
 * The fleet state screens render (zustand). Written only by the fleet client
 * (`src/fleet/client.ts`); screens read it with `useFleetState`.
 */
import { create } from 'zustand';
import type { FleetSnapshot } from '../fleet/types';

export const initialFleet: FleetSnapshot = {
  connection: 'off',
  error: null,
  deviceId: null,
  fingerprint: '',
  devices: [],
  spaces: [],
  lines: {},
  mirrors: {},
  questions: [],
};

export const useFleetState = create<FleetSnapshot>(() => initialFleet);
