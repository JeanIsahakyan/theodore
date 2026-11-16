/**
 * How screens reach the clients: `useServices()` returns the app's
 * `AuthClient` and `FleetClient`. The app shell provides the real ones
 * (`app/_layout.tsx`); screens and their previews may provide mocks.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { AuthClient } from './auth/types';
import type { FleetClient } from './fleet/types';

export interface Services {
  auth: AuthClient;
  fleet: FleetClient;
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({
  services,
  children,
}: {
  services: Services;
  children: ReactNode;
}) {
  return (
    <ServicesContext.Provider value={services}>
      {children}
    </ServicesContext.Provider>
  );
}

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('useServices outside ServicesProvider');
  return s;
}
