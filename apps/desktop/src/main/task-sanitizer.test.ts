import { describe, expect, it } from 'vitest';
import type { PersistedTask } from '@photoallisai/contracts';

import { toRendererTask } from './task-sanitizer';

const baseTask: PersistedTask = {
  id: '4fdbbb8a-8c33-484a-9719-2d36d61c4f66',
  kind: 'export',
  assetId: null,
  status: 'queued',
  position: 0,
  progress: 0,
  attempt: 0,
  payload: {
    resultIds: ['32b027ec-aa41-4d0e-a9ea-5c42a2393108'],
    destinationDirectory: '/Users/private/Pictures/export'
  },
  errorCode: null,
  createdAt: 1,
  updatedAt: 1
};

describe('renderer task sanitization', () => {
  it('removes the local destination from export tasks without mutating persisted state', () => {
    const sanitized = toRendererTask(baseTask);

    expect(sanitized.payload).toEqual({ resultIds: baseTask.payload.resultIds });
    expect(baseTask.payload.destinationDirectory).toBe('/Users/private/Pictures/export');
  });

  it('preserves non-export task payloads', () => {
    const generation = { ...baseTask, kind: 'generation' as const, assetId: 'asset-1', payload: { prompt: 'clean' } };
    expect(toRendererTask(generation)).toBe(generation);
  });
});
