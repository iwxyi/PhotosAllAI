import { describe, expect, it } from 'vitest';

import { fileOperationFailureMessage } from './error-messages';

describe('renderer error messages', () => {
  it('maps known operation failures without exposing internal codes', () => {
    expect(fileOperationFailureMessage('RECOVERY_DESTINATION_CONFLICT')).toBe('目标文件存在冲突');
    expect(fileOperationFailureMessage('/Users/private/catalog.sqlite')).toBe('操作失败，请检查图库状态后重试');
    expect(fileOperationFailureMessage(null)).toBe('操作失败，请检查图库状态后重试');
  });
});
