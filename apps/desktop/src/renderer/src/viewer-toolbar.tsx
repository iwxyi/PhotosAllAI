import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, GripVertical, Plus, RotateCcw, X } from 'lucide-react';

const labels: Record<string, string> = { compare: '对比', zoom: '缩放', versions: '版本切换', library: '胶片带工具' };
const storageKey = 'photoallisai.viewer-toolbar.v1';
type Entry = { id: string; visible: boolean };
const defaultOrder = ['versions', 'zoom', 'compare', 'spacer-default', 'library'];
const legacyOrder = ['compare', 'zoom', 'review', 'versions', 'export', 'spacer-default', 'library'];
const defaults = (): Entry[] => defaultOrder.map((id) => ({ id, visible: true }));
const isSpacer = (id: string) => id.startsWith('spacer-');

function loadLayout(): Entry[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (!Array.isArray(saved)) return defaults();
    if (saved.length === legacyOrder.length && saved.every((entry, index) => entry?.id === legacyOrder[index] && entry.visible === true)) return defaults();
    const seen = new Set<string>();
    const entries = saved.filter((item): item is Entry => {
      if (!item || typeof item.id !== 'string' || typeof item.visible !== 'boolean' || seen.has(item.id) || (!labels[item.id] && !isSpacer(item.id))) return false;
      seen.add(item.id);
      return true;
    }).slice(0, 40);
    return [...entries, ...defaults().filter((entry) => !isSpacer(entry.id) && !entries.some((item) => item.id === entry.id))];
  } catch { return defaults(); }
}

export function ViewerToolbar({ children }: { children: ReactNode }): React.JSX.Element {
  const [layout, setLayout] = useState(loadLayout);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const groups = new Map(Children.toArray(children).flatMap((child) => isValidElement<{ 'data-tool-group': string }>(child) ? [[child.props['data-tool-group'], child] as const] : []));

  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(layout)); } catch { /* Keep the current layout when storage is unavailable. */ } }, [layout]);
  useEffect(() => {
    if (!position) return;
    const toolbar = toolbarRef.current;
    const focusedBeforeOpen = previousFocus.current;
    dialogRef.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setPosition(null);
    };
    window.addEventListener('keydown', close, true);
    return () => {
      window.removeEventListener('keydown', close, true);
      if (focusedBeforeOpen?.isConnected) focusedBeforeOpen.focus({ preventScroll: true });
      else if (toolbar?.isConnected) toolbar.focus({ preventScroll: true });
    };
  }, [position]);

  const move = (id: string, target: string) => setLayout((current) => {
    const next = [...current];
    const from = next.findIndex((entry) => entry.id === id);
    const to = next.findIndex((entry) => entry.id === target);
    if (from < 0 || to < 0 || from === to) return current;
    next.splice(to, 0, next.splice(from, 1)[0]!);
    return next;
  });

  return <>
    <div className="viewer-footer" ref={toolbarRef} tabIndex={-1} onContextMenu={(event) => {
      event.preventDefault();
      event.stopPropagation();
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPosition({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 304)), y: Math.max(8, Math.min(event.clientY - 350, window.innerHeight - 440)) });
    }}>
      {layout.filter((entry) => isSpacer(entry.id) || groups.has(entry.id)).map((entry) => <div key={entry.id} data-toolbar-item={entry.id} hidden={!entry.visible} className={isSpacer(entry.id) ? 'viewer-toolbar-spacer' : 'viewer-toolbar-group'}>{groups.get(entry.id)}</div>)}
    </div>
    {position && createPortal(<div className="toolbar-customize-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setPosition(null); }}>
      <div className="toolbar-customize" role="dialog" aria-modal="true" aria-label="自定义看图工具栏" tabIndex={-1} ref={dialogRef} style={{ left: position.x, top: position.y }} onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input')];
        const index = controls.indexOf(document.activeElement as HTMLElement);
        event.preventDefault();
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      }}>
        <header><strong>自定义工具栏</strong><button type="button" title="关闭" aria-label="关闭工具栏设置" onClick={() => setPosition(null)}><X size={15} /></button></header>
        <div className="toolbar-customize-list">
          {layout.map((entry, index) => <div className={`toolbar-customize-row${dragged === entry.id ? ' is-dragging' : ''}`} key={entry.id} data-layout-id={entry.id} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }} onDrop={(event) => { event.preventDefault(); if (dragged) move(dragged, entry.id); setDragged(null); }}>
            <span className="toolbar-drag-handle" draggable onDragStart={(event) => { setDragged(entry.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', entry.id); }} onDragEnd={() => setDragged(null)} title="拖动排序"><GripVertical size={14} /></span>
            <label><input type="checkbox" checked={entry.visible} onChange={() => setLayout((current) => current.map((item) => item.id === entry.id ? { ...item, visible: !item.visible } : item))} />{labels[entry.id] ?? '弹性空白'}</label>
            <button type="button" aria-label={`上移${labels[entry.id] ?? '弹性空白'}`} title="上移" disabled={index === 0} onClick={() => move(entry.id, layout[index - 1]!.id)}><ArrowUp size={13} /></button>
            <button type="button" aria-label={`下移${labels[entry.id] ?? '弹性空白'}`} title="下移" disabled={index === layout.length - 1} onClick={() => move(entry.id, layout[index + 1]!.id)}><ArrowDown size={13} /></button>
            {isSpacer(entry.id) && <button type="button" aria-label="移除弹性空白" title="移除" onClick={() => setLayout((current) => current.filter((item) => item.id !== entry.id))}><X size={13} /></button>}
          </div>)}
        </div>
        <footer><button type="button" onClick={() => setLayout((current) => [...current, { id: `spacer-${crypto.randomUUID()}`, visible: true }])}><Plus size={14} />弹性空白</button><button type="button" onClick={() => setLayout(defaults())}><RotateCcw size={13} />恢复默认</button></footer>
      </div>
    </div>, document.body)}
  </>;
}
