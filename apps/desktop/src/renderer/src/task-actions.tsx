import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ChevronRight, FolderOpen, Image, Pause, Play, RotateCcw, Trash2, X } from 'lucide-react';
import type { DeleteTasksInput, PersistedTask, TaskBatchActionInput } from '@photoallisai/contracts';

export const TASKS_CHANGED_EVENT = 'photoallisai:tasks-changed';
const TaskActionsContext = createContext<{ busy: boolean; remove: (input: DeleteTasksInput) => void; batchAction: (input: TaskBatchActionInput) => void }>({ busy: false, remove: () => undefined, batchAction: () => undefined });

export function TaskBatchButtons({ tasks }: { tasks: PersistedTask[] }) {
  const { busy, remove, batchAction } = useContext(TaskActionsContext);
  const first = tasks[0]!;
  const retryable = tasks.some((task) => ['failed', 'canceled'].includes(task.status));
  return <span className="task-batch-actions" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
    <button type="button" title="重试失败或取消项" aria-label="重试批次失败项" disabled={busy || !retryable} onClick={() => batchAction({ taskId: first.id, action: 'retry' })}><RotateCcw size={14} /></button>
    <button type="button" title="删除批次" aria-label="删除批次" disabled={busy} onClick={() => remove({ scope: 'batch', taskId: first.id })}><X size={14} /></button>
  </span>;
}

export function TaskClearButton({ disabled }: { disabled: boolean }) {
  const { busy, remove } = useContext(TaskActionsContext);
  return <button className="quiet-button" type="button" disabled={disabled || busy} onClick={() => remove({ scope: 'all' })}><Trash2 size={13} />清空</button>;
}

export function TaskActions({ tasks, onOpenViewer, onEditTask, children }: {
  tasks: PersistedTask[]; onOpenViewer: (id: string, assetIds?: string[]) => void;
  onEditTask?: (task: PersistedTask) => void; children: React.ReactNode;
}) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; batch: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteExpanded, setDeleteExpanded] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const batchElement = useRef<HTMLDetailsElement | null>(null);
  const task = tasks.find((item) => item.id === menu?.id);
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const bounds = menuRef.current.getBoundingClientRect();
    menuRef.current.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`;
    menuRef.current.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`;
  }, [menu, task?.status, deleteExpanded]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      if (!items.length) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[index]?.focus();
    };
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', keydown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);
  const perform = async (action: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setError(''); setMenu(null);
    try {
      const result = await action();
      window.dispatchEvent(new CustomEvent(TASKS_CHANGED_EVENT, { detail: result }));
    } catch {
      setError('任务操作失败，任务状态可能已变化，请刷新后重试。');
    } finally { lock.current = false; setBusy(false); }
  };
  const remove = (input: DeleteTasksInput) => { void perform(() => window.desktopApi.deleteTasks({ ...input, orderedTaskIds: tasks.map((item) => item.id) })); };
  const batchAction = (input: TaskBatchActionInput) => { void perform(() => window.desktopApi.actOnTaskBatch(input)); };
  const queued = tasks.filter((item) => item.status === 'queued');
  const batchKey = (item: PersistedTask) => `${item.kind}:${item.payload.submissionId ?? item.payload.batchId ?? item.id}`;
  const members = task ? tasks.filter((item) => batchKey(item) === batchKey(task)) : [];
  const hasStatus = (statuses: string[]) => members.some((item) => statuses.includes(item.status));
  return <TaskActionsContext.Provider value={{ busy, remove, batchAction }}><div className="task-interaction-layer" onContextMenu={(event) => {
    const row = (event.target as Element).closest<HTMLElement>('[data-task-id], [data-task-batch]');
    if (!row || busy) return;
    event.preventDefault();
    setDeleteExpanded(false);
    batchElement.current = row.closest('details');
    setMenu({ id: row.dataset.taskId ?? row.dataset.taskBatch!, batch: Boolean(row.dataset.taskBatch), x: event.clientX, y: event.clientY });
  }}>{children}</div>
    {error && createPortal(<div className="operation-toast task-action-error" role="alert">{error}<button type="button" aria-label="关闭提示" onClick={() => setError('')}><X size={14} /></button></div>, document.body)}
    {menu && task && createPortal(<div ref={menuRef} className="folder-context-menu task-context-menu" role="menu" aria-label={menu.batch ? '批次操作' : '图片任务操作'} style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
      {menu.batch ? <>
        <button type="button" role="menuitem" onClick={() => { if (batchElement.current) batchElement.current.open = !batchElement.current.open; setMenu(null); }}>{batchElement.current?.open ? '收起批次' : '展开批次'}</button>
        {hasStatus(['queued', 'preparing', 'uploading', 'processing', 'downloading']) && <button type="button" role="menuitem" onClick={() => batchAction({ taskId: task.id, action: 'pause' })}><Pause size={14} />暂停批次</button>}
        {hasStatus(['paused']) && <button type="button" role="menuitem" onClick={() => batchAction({ taskId: task.id, action: 'resume' })}><Play size={14} />恢复暂停项</button>}
        {hasStatus(['draft', 'queued', 'paused', 'preparing', 'uploading', 'processing', 'downloading']) && <button type="button" role="menuitem" onClick={() => batchAction({ taskId: task.id, action: 'cancel' })}><X size={14} />取消未完成项</button>}
        <span className="folder-menu-separator" />
      </> : <>
      {task.assetId && <><button type="button" role="menuitem" onClick={() => { onOpenViewer(task.assetId!, members.flatMap((item) => item.assetId ? [item.assetId] : [])); setMenu(null); }}><Image size={14} />查看图片</button><button type="button" role="menuitem" onClick={() => { void perform(async () => { if (!await window.desktopApi.revealCatalogAsset(task.assetId!)) throw new Error('ASSET_UNAVAILABLE'); }); }}><FolderOpen size={14} />打开原图位置</button><span className="folder-menu-separator" /></>}
      {['failed', 'canceled'].includes(task.status) && <button type="button" role="menuitem" disabled={busy} onClick={() => { void perform(() => window.desktopApi.retryTask(task.id)); }}><RotateCcw size={14} />重试任务</button>}
      {['queued', 'preparing', 'uploading', 'processing', 'downloading'].includes(task.status) && <button type="button" role="menuitem" disabled={busy} onClick={() => { void perform(() => window.desktopApi.pauseTask(task.id)); }}><Pause size={14} />暂停任务</button>}
      {task.status === 'paused' && <button type="button" role="menuitem" disabled={busy} onClick={() => { void perform(() => window.desktopApi.resumeTask(task.id)); }}><Play size={14} />恢复任务</button>}
      {['queued', 'paused', 'preparing', 'uploading', 'processing', 'downloading'].includes(task.status) && <button type="button" role="menuitem" disabled={busy} onClick={() => { void perform(() => window.desktopApi.cancelTask(task.id)); }}><X size={14} />取消任务</button>}
      {task.status === 'queued' && <><button type="button" role="menuitem" disabled={busy || queued[0]?.id === task.id} onClick={() => { void perform(() => window.desktopApi.moveQueuedTask({ taskId: task.id, direction: -1 })); }}><ArrowUp size={14} />任务上移</button><button type="button" role="menuitem" disabled={busy || queued.at(-1)?.id === task.id} onClick={() => { void perform(() => window.desktopApi.moveQueuedTask({ taskId: task.id, direction: 1 })); }}><ArrowDown size={14} />任务下移</button></>}
      {task.kind === 'generation' && task.status === 'queued' && onEditTask && <button type="button" role="menuitem" onClick={() => { onEditTask(task); setMenu(null); }}>编辑生成提示词</button>}
      <span className="folder-menu-separator" />
      <button type="button" role="menuitem" disabled={busy} onClick={() => remove({ scope: 'task', taskId: task.id })}><Trash2 size={14} />删除任务</button>
      </>}
      <button type="button" role="menuitem" aria-expanded={deleteExpanded} aria-controls="task-bulk-delete-options" onClick={() => setDeleteExpanded((expanded) => !expanded)}><Trash2 size={14} />批量删除<ChevronRight size={14} className={deleteExpanded ? 'task-delete-chevron is-expanded' : 'task-delete-chevron'} /></button>
      {deleteExpanded && <div id="task-bulk-delete-options" className="task-delete-options" role="group" aria-label="批量删除">
        {(menu.batch ? [
          ['below-batches', '删除下面所有批次'], ['all', '删除所有任务'], ['unfinished', '删除未完成任务']
        ] : [
          ['below', '删除本批下面的项'], ['batch', '删除本批全部项'], ['batch-unfinished', '删除本批未完成项']
        ]).map(([scope, label]) => <button key={scope} type="button" role="menuitem" disabled={busy} onClick={() => remove({ scope: scope as DeleteTasksInput['scope'], taskId: task.id })}>{label}</button>)}
      </div>}
    </div>, document.body)}
  </TaskActionsContext.Provider>;
}
