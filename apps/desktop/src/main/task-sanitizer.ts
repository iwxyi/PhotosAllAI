import { exportReportSchema, type PersistedTask } from '@photoallisai/contracts';

export function toRendererTask(task: PersistedTask): PersistedTask {
  if (task.kind !== 'export') return task;
  const payload = { ...task.payload };
  delete payload.destinationDirectory;
  const parsedResult = exportReportSchema.safeParse(task.result);
  return { ...task, payload, result: parsedResult.success ? parsedResult.data : null };
}
