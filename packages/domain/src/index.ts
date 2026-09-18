export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'preparing'
  | 'uploading'
  | 'processing'
  | 'downloading'
  | 'saving'
  | 'completed'
  | 'failed'
  | 'canceled';

const transitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ['queued', 'canceled'],
  queued: ['preparing', 'canceled'],
  preparing: ['uploading', 'processing', 'failed', 'canceled'],
  uploading: ['processing', 'failed', 'canceled'],
  processing: ['downloading', 'failed', 'canceled'],
  downloading: ['saving', 'failed', 'canceled'],
  saving: ['completed', 'failed'],
  completed: [],
  failed: ['queued', 'canceled'],
  canceled: ['queued']
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

