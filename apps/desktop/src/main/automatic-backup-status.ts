export type AutomaticBackupStatus = 'pending' | 'completed' | 'skipped' | 'failed';

export function classifyAutomaticBackupResult(result: unknown): AutomaticBackupStatus {
  return result === null ? 'skipped' : 'completed';
}

export function classifyAutomaticBackupFailure(): AutomaticBackupStatus {
  return 'failed';
}
