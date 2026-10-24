import type { PersistedTask } from '@photoallisai/contracts';

export function groupTaskBatches(tasks: PersistedTask[]) {
  const groups = new Map<string, PersistedTask[]>();
  for (const task of tasks) {
    const batchId = task.payload.submissionId ?? task.payload.batchId;
    const id = `${task.kind}:${typeof batchId === 'string' ? batchId : task.id}`;
    const members = groups.get(id) ?? [];
    if (!members.some((member) => member.id === task.id)) members.push(task);
    groups.set(id, members);
  }
  return [...groups].map(([id, members]) => ({ id, tasks: members, ...batchProgress(members) }));
}

export function batchProgress(tasks: PersistedTask[]) {
  const units = tasks.map((task) => {
    const terminal = ['completed', 'failed', 'canceled'].includes(task.status);
    const processing = ['preparing', 'uploading', 'processing', 'downloading', 'saving'].includes(task.status);
    if (task.kind === 'export' && Array.isArray(task.payload.resultIds)) {
      const total = new Set(task.payload.resultIds).size;
      const completed = Math.min(total, Number(task.result?.succeeded) || 0);
      const failed = Math.min(total - completed, Number(task.result?.failed) || 0);
      const remaining = total - completed - failed;
      return { total, completed, failed: failed + (task.status === 'failed' ? remaining : 0),
        canceled: task.status === 'canceled' ? remaining : 0,
        active: processing ? Math.min(remaining, 1) : 0,
        queued: !terminal && task.status !== 'paused' ? remaining - (processing ? Math.min(remaining, 1) : 0) : 0,
        paused: task.status === 'paused' ? remaining : 0 };
    }
    return { total: 1, completed: Number(task.status === 'completed'), failed: Number(task.status === 'failed'),
      canceled: Number(task.status === 'canceled'), active: Number(processing),
      queued: Number(['queued', 'draft'].includes(task.status)), paused: Number(task.status === 'paused') };
  });
  const counts = units.reduce((sum, item) => ({ total: sum.total + item.total, completed: sum.completed + item.completed,
    failed: sum.failed + item.failed, canceled: sum.canceled + item.canceled, active: sum.active + item.active,
    queued: sum.queued + item.queued, paused: sum.paused + item.paused }),
    { total: 0, completed: 0, failed: 0, canceled: 0, active: 0, queued: 0, paused: 0 });
  const settled = counts.completed + counts.failed + counts.canceled;
  return { ...counts, settled, progress: counts.total ? settled / counts.total : 0 };
}
