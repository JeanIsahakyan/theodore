import { afterEach, describe, expect, it, vi } from 'vitest';
import { click, mount, type Mounted } from '../../test/dom';
import { RevisionError, firstLine } from './RevisionError';

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

const STDERR =
  "\nfatal: bad object 0123abcd\nerror: remote did not send all necessary objects\nhint: try 'git fetch'";

describe('firstLine', () => {
  it('takes the first non-empty line, trimmed', () => {
    expect(firstLine(STDERR)).toBe('fatal: bad object 0123abcd');
    expect(firstLine(undefined)).toBe('');
    expect(firstLine('  \n ')).toBe('');
  });
});

describe('RevisionError', () => {
  it('says what failed, shows only the first line of the error, and retries', async () => {
    const onRetry = vi.fn();
    m = await mount(<RevisionError error={STDERR} onRetry={onRetry} />);
    const text = m.host.textContent ?? '';
    expect(text).toContain('Couldn’t load this revision');
    expect(text).toContain('fatal: bad object 0123abcd');
    expect(text).not.toContain('remote did not send');
    const retry = [...m.host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Retry',
    );
    await click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
