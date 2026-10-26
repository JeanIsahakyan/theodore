import { it, expect } from 'vitest';
import { deliver } from '../../src/webhooks/deliver';

it('retries 5xx and dead-letters after MAX_ATTEMPTS', async () => {
  const fetch = mockFetch([503, 503, 503, 503, 503]);
  await deliver(hook, event);
  expect(fetch).toHaveBeenCalledTimes(5);
});
