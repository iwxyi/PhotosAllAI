import type { PersistedTask } from '@photoallisai/contracts';

export function toRendererTask(task: PersistedTask): PersistedTask {
  if (task.kind !== 'export') return task;
  const payload = { ...task.payload };
  delete payload.destinationDirectory;
  return { ...task, payload };
}
