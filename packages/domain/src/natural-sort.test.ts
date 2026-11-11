import { describe, expect, it } from 'vitest';
import { compareNaturalNames, naturalSortKey } from './natural-sort';

describe('natural file names', () => {
  it('orders numeric runs by value and keeps leading zero ties deterministic', () => {
    const names = ['导出10', '导出02', '导出2', '导出1'];
    expect([...names].sort((left, right) => naturalSortKey(left).localeCompare(naturalSortKey(right))))
      .toEqual(['导出1', '导出2', '导出02', '导出10']);
    expect([...names].sort(compareNaturalNames).map((name) => Number(name.slice(2))))
      .toEqual([1, 2, 2, 10]);
  });
});
