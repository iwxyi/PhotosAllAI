import { describe, expect, it } from 'vitest';
import type { PersistedTask } from '@photoallisai/contracts';
import { batchProgress, groupTaskBatches } from './task-batches';

function task(id: string, patch: Partial<PersistedTask> = {}): PersistedTask {
  return { id, kind: 'analysis', assetId: 'photo', status: 'queued', payload: {}, result: null,
    position: 0, progress: 0, attempt: 0, errorCode: null, createdAt: 1, updatedAt: 1, ...patch };
}

describe('submission progress', () => {
  it('keeps different submissions and types separate, retaining full mixed-status members', () => {
    const first = task('a', { payload: { submissionId: 'first' }, status: 'completed' });
    const second = task('b', { payload: { submissionId: 'first' }, status: 'failed' });
    const groups = groupTaskBatches([first, second, first,
      task('c', { payload: { submissionId: 'second' }, status: 'processing' }),
      task('d', { kind: 'generation', payload: { submissionId: 'first', batchId: 'photo-candidates' } }), task('legacy')]);
    expect(groups).toHaveLength(4);
    expect(groups.find((group) => group.id === 'analysis:first')).toMatchObject({ total: 2, completed: 1, failed: 1, settled: 2, progress: 1 });
    expect(groups.find((group) => group.id === 'analysis:second')).toMatchObject({ total: 1, active: 1, progress: 0 });
  });

  it('groups per-photo generation candidate sets under one submission', () => {
    const groups = groupTaskBatches(['photo-a', 'photo-b'].flatMap((batchId, index) => [
      task(`${index}-1`, { kind: 'generation', payload: { submissionId: 'click', batchId } }),
      task(`${index}-2`, { kind: 'generation', payload: { submissionId: 'click', batchId }, status: 'completed' })]));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ total: 4, completed: 2, queued: 2, progress: 0.5 });
  });

  it('orders submissions by creation time even when older batch members are appended later', () => {
    const older = task('old', { kind: 'generation', payload: { submissionId: 'old' }, createdAt: 100 });
    const newer = task('new', { kind: 'generation', payload: { submissionId: 'new' }, createdAt: 200 });
    const olderMember = task('old-2', { kind: 'generation', payload: { submissionId: 'old' }, createdAt: 101 });
    expect(groupTaskBatches([older, newer, olderMember]).map((group) => group.id)).toEqual(['generation:new', 'generation:old']);
  });

  it('counts export files and retains partial success when an export fails or is canceled', () => {
    const exportTask = task('export', { kind: 'export', status: 'processing', payload: { resultIds: ['one', 'two', 'three', 'one'] },
      result: { succeeded: 1, failed: 0 } });
    expect(batchProgress([exportTask])).toMatchObject({ total: 3, completed: 1, active: 1, queued: 1, progress: 1 / 3 });
    expect(batchProgress([{ ...exportTask, status: 'failed' }])).toMatchObject({ total: 3, completed: 1, failed: 2, progress: 1 });
    expect(batchProgress([{ ...exportTask, status: 'canceled' }])).toMatchObject({ total: 3, completed: 1, canceled: 2, progress: 1 });
  });
});
