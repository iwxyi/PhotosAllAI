import { exportReportSchema, type PersistedTask } from '@photoallisai/contracts';

import { normalizeTaskErrorCode } from './task-error-code';

const FALLBACK_ERROR_CODES: Record<PersistedTask['kind'], string> = {
  analysis: 'ANALYSIS_FAILED',
  generation: 'GENERATION_FAILED',
  export: 'EXPORT_FAILED'
};

export function toRendererTask(task: PersistedTask): PersistedTask {
  const errorCode = task.errorCode === null
    ? null
    : normalizeTaskErrorCode(task.errorCode, FALLBACK_ERROR_CODES[task.kind]);
  if (task.kind !== 'export') {
    return errorCode === task.errorCode ? task : { ...task, errorCode };
  }
  const payload = { ...task.payload };
  delete payload.destinationDirectory;
  const parsedResult = exportReportSchema.safeParse(task.result);
  return { ...task, payload, result: parsedResult.success ? parsedResult.data : null, errorCode };
}
