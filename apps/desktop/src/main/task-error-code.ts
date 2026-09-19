const STABLE_ERROR_CODE = /^(?:ANALYSIS|ASSET|CREDENTIAL|EXPORT|GENERATED_IMAGE|GENERATION|PROVIDER|TASK)_[A-Z0-9_]+$/u;

export function normalizeTaskErrorCode(error: unknown, fallback: string): string {
  const candidate = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return candidate.length <= 200 && STABLE_ERROR_CODE.test(candidate) ? candidate : fallback;
}
