export const MAX_ATTEMPTS = 5;
export const MAX_BACKOFF_MS = 30_000;

export function backoff(attempt: number) {
  const base = 500 * 2 ** attempt;
  const capped = Math.min(base, MAX_BACKOFF_MS);
  return capped + Math.random() * capped * 0.2;
}
