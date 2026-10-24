import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { normalizeTaskErrorCode } from './task-error-code';

describe('task error classification', () => {
  it('classifies invalid task data without exposing schema input', () => {
    const result = z.object({ provider: z.string() }).safeParse({ privatePath: '/private/image.jpg' });
    if (result.success) throw new Error('Expected invalid fixture');
    expect(normalizeTaskErrorCode(result.error, 'ANALYSIS_FAILED')).toBe('TASK_DATA_INVALID');
  });

  it.each([
    ['ENOENT', 'TASK_FILE_NOT_FOUND'], ['EPERM', 'TASK_FILE_ACCESS_DENIED'],
    ['ENOSPC', 'TASK_DISK_FULL'], ['SQLITE_BUSY', 'TASK_DATABASE_BUSY']
  ])('classifies system error %s without leaking file paths', (code, expected) => {
    const error = Object.assign(new Error('/Users/private/image.jpg'), { code });
    expect(normalizeTaskErrorCode(error, 'ANALYSIS_FAILED')).toBe(expected);
  });

  it('keeps unknown provider text private', () => {
    expect(normalizeTaskErrorCode(new Error('secret api-key'), 'ANALYSIS_FAILED')).toBe('ANALYSIS_FAILED');
  });
});
