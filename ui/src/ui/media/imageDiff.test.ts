import { describe, expect, it } from 'vitest';
import {
  clampPercent,
  cycleImageDiffMode,
  formatBytes,
  formatSizeDelta,
  isImageDiffPath,
} from './imageDiff';

describe('isImageDiffPath', () => {
  it('recognizes every supported extension, case-insensitively', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']) {
      expect(isImageDiffPath(`a/b.${ext}`)).toBe(true);
      expect(isImageDiffPath(`a/b.${ext.toUpperCase()}`)).toBe(true);
    }
  });

  it('rejects a non-image extension', () => {
    expect(isImageDiffPath('a/b.ts')).toBe(false);
    expect(isImageDiffPath('a/b.psd')).toBe(false);
  });

  it('rejects a path with no extension and a trailing dot', () => {
    expect(isImageDiffPath('README')).toBe(false);
    expect(isImageDiffPath('a/b.')).toBe(false);
  });
});

describe('cycleImageDiffMode', () => {
  it('cycles side-by-side -> swipe -> onion -> side-by-side', () => {
    expect(cycleImageDiffMode('side-by-side')).toBe('swipe');
    expect(cycleImageDiffMode('swipe')).toBe('onion');
    expect(cycleImageDiffMode('onion')).toBe('side-by-side');
  });
});

describe('clampPercent', () => {
  it('passes through an in-range value', () => {
    expect(clampPercent(42)).toBe(42);
  });

  it('clamps below 0 and above 100', () => {
    expect(clampPercent(-10)).toBe(0);
    expect(clampPercent(140)).toBe(100);
  });

  it('falls back to the midpoint for NaN', () => {
    expect(clampPercent(Number.NaN)).toBe(50);
  });
});

describe('formatBytes', () => {
  it('shows bytes under 1 KB as-is', () => {
    expect(formatBytes(834)).toBe('834 B');
    expect(formatBytes(0)).toBe('0 B');
  });

  it('shows kilobytes with one decimal place', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(12_697)).toBe('12.4 KB');
  });

  it('shows megabytes for a large file', () => {
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('formatSizeDelta', () => {
  it('is empty when either side is missing (an added or deleted file)', () => {
    expect(formatSizeDelta(null, 2048)).toBe('');
    expect(formatSizeDelta(2048, null)).toBe('');
  });

  it('reports no change when sizes match', () => {
    expect(formatSizeDelta(1024, 1024)).toBe('no size change');
  });

  it('reports a growth with a percentage', () => {
    expect(formatSizeDelta(1000, 1100)).toBe('+100 B (+10%)');
  });

  it('reports a shrink with a percentage', () => {
    expect(formatSizeDelta(2000, 1000)).toBe('-1000 B (-50%)');
  });

  it('omits the percentage when the before size is 0', () => {
    expect(formatSizeDelta(0, 500)).toBe('+500 B');
  });
});
