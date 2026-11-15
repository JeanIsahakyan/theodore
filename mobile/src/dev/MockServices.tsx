/**
 * Wraps a tree in mock services and a seeded store, to preview screens
 * without a backend: `<MockServices><SpacesScreen /></MockServices>`.
 */
import { useMemo, type ReactNode } from 'react';
import { ServicesProvider } from '../services';
import { createMock, type MockOptions } from './mock';

export function MockServices({
  children,
  options,
}: {
  children: ReactNode;
  options?: MockOptions;
}) {
  const mock = useMemo(() => createMock(options), [options]);
  return (
    <ServicesProvider services={mock.services}>{children}</ServicesProvider>
  );
}
