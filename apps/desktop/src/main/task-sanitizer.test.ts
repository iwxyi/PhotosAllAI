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
  result: null,
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

  it('drops malformed export results instead of exposing unknown fields', () => {
    const sanitized = toRendererTask({
      ...baseTask,
      result: { destinationDirectory: '/Users/private/Pictures/export', succeeded: 1 }
    });

    expect(sanitized.result).toBeNull();
  });

  it('replaces historical free-form errors before returning tasks to the renderer', () => {
    const privateDetail = '/Users/private/Pictures/export';
    const exportTask = toRendererTask({ ...baseTask, errorCode: `ENOENT: no such directory, ${privateDetail}` });
    const generationTask = toRendererTask({
      ...baseTask,
      kind: 'generation',
      assetId: 'asset-1',
      payload: {},
      errorCode: `provider echoed ${privateDetail}`
    });

    expect(exportTask.errorCode).toBe('EXPORT_FAILED');
    expect(generationTask.errorCode).toBe('GENERATION_FAILED');
    expect(JSON.stringify([exportTask, generationTask])).not.toContain(privateDetail);
  });

  it('preserves stable task error codes', () => {
    for (const errorCode of ['PROVIDER_CONNECTION_FAILED', 'ANALYSIS_RESPONSE_SCHEMA_INVALID', 'IMAGE_PREVIEW_UNAVAILABLE', 'COLLECTION_ANALYSIS_REQUIRES_MULTIPLE_ANALYSES']) {
      expect(toRendererTask({ ...baseTask, kind: 'analysis', errorCode }).errorCode).toBe(errorCode);
    }
    expect(toRendererTask({ ...baseTask, errorCode: 'EXPORT_DESTINATION_NOT_DIRECTORY' }).errorCode)
      .toBe('EXPORT_DESTINATION_NOT_DIRECTORY');
    expect(toRendererTask({ ...baseTask, errorCode: 'PRIVATE_SECRET' }).errorCode).toBe('EXPORT_FAILED');
  });
});
