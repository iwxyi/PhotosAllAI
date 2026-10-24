const STABLE_ERROR_CODE = /^(?:ANALYSIS|COLLECTION_ANALYSIS|ASSET|CREDENTIAL|EXPORT|GENERATED_IMAGE|GENERATION|IMAGE|PROVIDER|TASK)_[A-Z0-9_]+$/u;

export function normalizeTaskErrorCode(error: unknown, fallback: string): string {
  if (error instanceof Error && error.name === 'ZodError') return 'TASK_DATA_INVALID';
  if (error instanceof Error && 'code' in error) {
    switch (error.code) {
      case 'ENOENT': return 'TASK_FILE_NOT_FOUND';
      case 'EACCES':
      case 'EPERM': return 'TASK_FILE_ACCESS_DENIED';
      case 'ENOSPC': return 'TASK_DISK_FULL';
      case 'SQLITE_BUSY':
      case 'ERR_SQLITE_BUSY': return 'TASK_DATABASE_BUSY';
    }
  }
  const candidate = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return candidate.length <= 200 && STABLE_ERROR_CODE.test(candidate) ? candidate : fallback;
}
