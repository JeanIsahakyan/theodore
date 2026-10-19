/**
 * Dev-only render counters: a component calls `countRender('Line')` in its
 * body and a test reads how often it ran. `import.meta.env.DEV` is a
 * build-time constant, so a production bundle keeps only an empty function.
 */
const counts = new Map<string, number>();

export function countRender(name: string): void {
  if (!import.meta.env.DEV) return;
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

export const renderCounts = {
  get: (name: string): number => counts.get(name) ?? 0,
  reset: (): void => counts.clear(),
};
