import { describe, expect, it } from 'vitest';

import { classifyAutomaticBackupFailure, classifyAutomaticBackupResult } from './automatic-backup-status';

describe('automatic backup diagnostic status', () => {
  it('distinguishes a created backup from an interval skip', () => {
    expect(classifyAutomaticBackupResult({ destinationPath: 'redacted' })).toBe('completed');
    expect(classifyAutomaticBackupResult(null)).toBe('skipped');
  });

  it('records failures without exposing the underlying error', () => {
    expect(classifyAutomaticBackupFailure()).toBe('failed');
  });
});
