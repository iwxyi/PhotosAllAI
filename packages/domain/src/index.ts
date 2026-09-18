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

export type SelectionIntent = 'replace' | 'toggle' | 'range';

export type SelectionState = {
  selectedIds: ReadonlySet<string>;
  anchorId: string | null;
  focusId: string | null;
};

export function updateSelection(
  state: SelectionState,
  orderedIds: readonly string[],
  targetId: string,
  intent: SelectionIntent
): SelectionState {
  if (!orderedIds.includes(targetId)) return state;

  if (intent === 'replace') {
    return { selectedIds: new Set([targetId]), anchorId: targetId, focusId: targetId };
  }

  if (intent === 'toggle') {
    const selectedIds = new Set(state.selectedIds);
    if (selectedIds.has(targetId)) selectedIds.delete(targetId);
    else selectedIds.add(targetId);
    return { selectedIds, anchorId: targetId, focusId: targetId };
  }

  const anchorId = state.anchorId && orderedIds.includes(state.anchorId) ? state.anchorId : targetId;
  const anchorIndex = orderedIds.indexOf(anchorId);
  const targetIndex = orderedIds.indexOf(targetId);
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);

  return {
    selectedIds: new Set(orderedIds.slice(start, end + 1)),
    anchorId,
    focusId: targetId
  };
}

export function selectAll(orderedIds: readonly string[]): SelectionState {
  return {
    selectedIds: new Set(orderedIds),
    anchorId: orderedIds[0] ?? null,
    focusId: orderedIds[0] ?? null
  };
}

export { composeGenerationPrompt, type ComposePromptInput } from './prompt-composer';
