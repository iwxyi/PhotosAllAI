import { describe, expect, it } from 'vitest';

import { computeHorizontalWindow } from './index';

describe('horizontal virtual window', () => {
  it('renders a bounded slice for a 100,000 item collection', () => {
    const window = computeHorizontalWindow(100_000, 137, 1_370, 6_850_000, 4);
    expect(window.totalSize).toBe(13_700_000);
    expect(window.end - window.start).toBeLessThanOrEqual(18);
    expect(window.start).toBeGreaterThan(49_000);
  });

  it('clamps the first and last windows', () => {
    expect(computeHorizontalWindow(6, 137, 1_000, 0, 4)).toEqual({ start: 0, end: 6, totalSize: 822 });
    const end = computeHorizontalWindow(100, 137, 1_000, Number.MAX_SAFE_INTEGER, 4);
    expect(end.end).toBe(100);
    expect(end.start).toBe(96);
  });

  it('handles empty and invalid collections safely', () => {
    expect(computeHorizontalWindow(0, 137, 1_000, 0)).toEqual({ start: 0, end: 0, totalSize: 0 });
    expect(computeHorizontalWindow(10, 0, 1_000, 0)).toEqual({ start: 0, end: 0, totalSize: 0 });
  });
});
