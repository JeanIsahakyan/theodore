export const MAX_ATTEMPTS = 5;

export function backoff(attempt: number) {
  const base = 500 * 2 ** attempt;
  return base + Math.random() * base * 0.2;
}
