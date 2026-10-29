import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, CalendarDays, ChevronDown, Folder, Grid2X2, LoaderCircle, Plus, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import { browseDimensions, browseLabels, defaultGroupOrder, type BrowseDimension, type BrowseFilters } from './catalog-browse';
import { ToolbarCustomizeRow } from './toolbar-customize-row';

const dimensions = Object.keys(browseDimensions) as BrowseDimension[];
const toolLabels: Record<string, string> = { title: '标题', count: '文件数量', workflow: '流程配置', version: '流程版本', view: '视图', sort: '排序', search: '搜索', stars: '星级', flags: '留用', colors: '颜色', favorites: '收藏', reset: '重置' };
const toolIds = Object.keys(toolLabels);
const defaultTools = toolIds.filter((id) => !['sort', 'search', 'view'].includes(id));
const allItems = ['title', 'count', 'date', 'folder', ...dimensions.filter((id) => id !== 'date' && id !== 'folder'), 'spacer-default', ...toolIds.filter((id) => id !== 'title' && id !== 'count')];
const orderKey = 'photoallisai.catalog-toolbar-order.v2';
const visibleToolsKey = 'photoallisai.catalog-toolbar-tools.v3';
const isDecoration = (id: string) => id.startsWith('spacer-') || id.startsWith('separator-');
const labelFor = (id: string) => isDecoration(id) ? (id.startsWith('spacer-') ? '弹性空白' : '分割线') : toolLabels[id] ?? `分组:${browseLabels[id as BrowseDimension]}`;
const isDimension = (id: string): id is BrowseDimension => dimensions.includes(id as BrowseDimension);

function SortableFacet({ id, active, children }: { id: string; active: boolean; children: ReactNode }): React.JSX.Element {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !isDimension(id) });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition, zIndex: isDragging ? 10 : undefined };
  return <span ref={(node) => { setNodeRef(node); setActivatorNodeRef(node); }} style={style} className={`${isDimension(id) ? 'catalog-facet' : 'catalog-toolbar-tool'}${active ? ' is-active' : ''}${isDragging ? ' is-dragging' : ''}`} data-catalog-tool={id} {...(isDimension(id) ? attributes : {})} {...(isDimension(id) ? listeners : {})} role="group" aria-label={`${labelFor(id)}${isDimension(id) ? '分组按钮' : '工具'}`}>{children}</span>;
}

export function CatalogBrowseControls({ value, onChange, pending = 0, total = 0, tools = {} }: {
  value: BrowseFilters;
  onChange: (next: BrowseFilters) => void;
  pending?: number;
  total?: number;
  tools?: Record<string, ReactNode>;
}): React.JSX.Element {
  const [visible, setVisible] = useState<BrowseDimension[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('photoallisai.catalog-filter-fields') ?? 'null');
      if (Array.isArray(saved)) return dimensions.filter((dimension) => saved.includes(dimension));
    } catch { /* restricted storage */ }
    return [];
  });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [shownTools, setShownTools] = useState<string[]>(() => {
    try {
      const current = localStorage.getItem(visibleToolsKey);
      const saved: unknown = JSON.parse(current ?? localStorage.getItem('photoallisai.catalog-toolbar-tools.v2') ?? localStorage.getItem('photoallisai.catalog-toolbar-tools') ?? 'null');
      if (current === null && Array.isArray(saved)) return ['title', 'count', 'version', ...toolIds.filter((id) => saved.includes(id))];
      if (Array.isArray(saved)) return toolIds.filter((id) => saved.includes(id));
    } catch { /* restricted storage */ }
    return defaultTools;
  });
  useEffect(() => { try { localStorage.setItem(visibleToolsKey, JSON.stringify(shownTools)); } catch { /* restricted storage */ } }, [shownTools]);
  const [toolbarOrder, setToolbarOrder] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(orderKey) ?? localStorage.getItem('photoallisai.catalog-group-toolbar-order') ?? 'null');
      if (Array.isArray(saved)) {
        const valid = [...new Set(saved.filter((id): id is string => typeof id === 'string' && (allItems.includes(id) || isDecoration(id))))];
        const withHeading = ['title', 'count', ...valid.filter((id) => id !== 'title' && id !== 'count')];
        if (!withHeading.includes('spacer-default')) withHeading.splice(Math.max(0, withHeading.indexOf('workflow')), 0, 'spacer-default');
        return [...withHeading, ...allItems.filter((id) => !withHeading.includes(id))];
      }
    } catch { /* restricted storage */ }
    return allItems;
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const displayedDimensions = toolbarOrder.filter((id) => isDecoration(id) || (isDimension(id) ? visible.includes(id) : shownTools.includes(id) && Boolean(tools[id])));
  const [exifOpen, setExifOpen] = useState(false);
  const menuItems = toolbarOrder.filter((id) => !isDimension(id) || browseDimensions[id].section === 'file' || exifOpen);
  const menuRef = useRef<HTMLDivElement>(null);
  const sorting = useRef(false);
  const previousFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element || !menu) return;
    const position = () => {
      element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - element.offsetWidth - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(menu.y + element.offsetHeight <= window.innerHeight - 8 ? menu.y : menu.y - element.offsetHeight, window.innerHeight - element.offsetHeight - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    return () => observer.disconnect();
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.focus();
    const focusedBeforeOpen = previousFocus.current;
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !sorting.current) { event.preventDefault(); event.stopImmediatePropagation(); setMenu(null); } };
    const resize = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', resize);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key, true); window.removeEventListener('resize', resize); if (focusedBeforeOpen?.isConnected) focusedBeforeOpen.focus({ preventScroll: true }); };
  }, [menu]);
  const toggleGroup = (dimension: BrowseDimension) => onChange({ ...value, groupBy: value.groupBy.includes(dimension) ? value.groupBy.filter((item) => item !== dimension) : [...value.groupBy, dimension] });
  const toggleOrder = (dimension: BrowseDimension) => onChange({ ...value, groupOrder: { ...value.groupOrder, [dimension]: (value.groupOrder[dimension] ?? defaultGroupOrder(dimension)) === 'asc' ? 'desc' : 'asc' } });
  const openMenu = (x: number, y: number) => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMenu({ x, y });
  };
  const reorder = (active: string, over: string) => {
    const from = toolbarOrder.indexOf(active);
    const to = toolbarOrder.indexOf(over);
    if (from < 0 || to < 0 || from === to) return;
    const next = arrayMove(toolbarOrder, from, to);
    setToolbarOrder(next);
    try { localStorage.setItem(orderKey, JSON.stringify(next)); } catch { /* restricted storage */ }
  };
  const addDecoration = (kind: 'spacer' | 'separator') => {
    const next = [...toolbarOrder, `${kind}-${crypto.randomUUID()}`];
    setToolbarOrder(next);
    try { localStorage.setItem(orderKey, JSON.stringify(next)); } catch { /* restricted storage */ }
  };
  const removeDecoration = (id: string) => {
    const next = toolbarOrder.filter((item) => item !== id);
    setToolbarOrder(next);
    try { localStorage.setItem(orderKey, JSON.stringify(next)); } catch { /* restricted storage */ }
  };
  const toggleVisible = (id: string) => {
    if (isDimension(id)) {
      const next = visible.includes(id) ? visible.filter((item) => item !== id) : [...visible, id];
      setVisible(next);
      try { localStorage.setItem('photoallisai.catalog-filter-fields', JSON.stringify(next)); } catch { /* restricted storage */ }
    } else {
      const next = shownTools.includes(id) ? shownTools.filter((item) => item !== id) : [...shownTools, id];
      setShownTools(next);
      try { localStorage.setItem(visibleToolsKey, JSON.stringify(next)); } catch { /* restricted storage */ }
    }
  };
  return <div className="catalog-browse-controls catalog-unified-toolbar" role="group" aria-label="图库工具栏" onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); openMenu(event.clientX, event.clientY); }}>
    <div className="catalog-toolbar-scroll" role="group" aria-label="图库过滤条件">
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
      if (!over || active.id === over.id) return;
      reorder(String(active.id), String(over.id));
    }}>
    <SortableContext items={displayedDimensions} strategy={rectSortingStrategy}>
    {displayedDimensions.map((dimension) => {
      if (isDecoration(dimension)) return <span key={dimension} data-catalog-tool={dimension} className={dimension.startsWith('spacer-') ? 'toolbar-layout-spacer' : 'viewer-toolbar-separator'} aria-hidden="true" />;
      if (!isDimension(dimension)) return <SortableFacet id={dimension} active={false} key={dimension}>{tools[dimension]}</SortableFacet>;
      const active = value.groupBy.includes(dimension);
      const ascending = (value.groupOrder[dimension] ?? defaultGroupOrder(dimension)) === 'asc';
      const Icon = dimension === 'folder' ? Folder : dimension === 'format' ? Grid2X2 : ['date', 'month', 'year', 'exifDay', 'exifMonth', 'exifYear'].includes(dimension) ? CalendarDays : SlidersHorizontal;
      const label = browseLabels[dimension];
      return <SortableFacet id={dimension} active={active} key={dimension}>
        <button type="button" aria-label={`按${label}分组`} aria-pressed={active} title={['date', 'month', 'year'].includes(dimension) ? `按文件修改${label}分组` : `按${label}分组`} onClick={() => toggleGroup(dimension)}><Icon size={13} /><span>{label}</span></button>
        <button className="catalog-facet-order" type="button" disabled={!active} aria-label={`${label}：${ascending ? '正序' : '逆序'}，点击切换`} title={ascending ? '正序，点击改为逆序' : '逆序，点击改为正序'} onClick={() => toggleOrder(dimension)}>{ascending ? <ArrowUp size={13} /> : <ArrowDown size={13} />}</button>
      </SortableFacet>;
    })}
    </SortableContext>
    </DndContext>
    </div>
    <button className="catalog-facet-options" type="button" aria-label="配置图库工具栏" title="自定义工具栏" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openMenu(rect.left, rect.bottom + 4); }}><ChevronDown size={12} /></button>
    {pending > 0 && <span className="catalog-group-loading" role="status" title="读取分组元数据"><LoaderCircle size={12} />{Math.max(0, total - pending)} / {total}</span>}
    {menu && createPortal(<div className="toolbar-customize-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setMenu(null); }}><div ref={menuRef} className="toolbar-customize" role="dialog" aria-modal="true" tabIndex={-1} aria-label="配置图库工具栏" style={{ left: menu.x, top: menu.y }} onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input')];
      const index = controls.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
    }}>
      <header><strong>自定义工具栏</strong><button type="button" title="关闭" aria-label="关闭工具栏设置" onClick={() => setMenu(null)}><X size={15} /></button></header>
      <div className="toolbar-customize-list">
      {value.groupBy.length > 1 && <><div className="catalog-group-menu-title">分组层级</div><DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={() => { sorting.current = true; }} onDragCancel={() => { sorting.current = false; }} onDragEnd={({ active, over }) => {
        sorting.current = false;
        if (over && active.id !== over.id) onChange({ ...value, groupBy: arrayMove(value.groupBy, value.groupBy.indexOf(active.id as BrowseDimension), value.groupBy.indexOf(over.id as BrowseDimension)) });
      }}><SortableContext items={value.groupBy} strategy={verticalListSortingStrategy}>{value.groupBy.map((dimension, index) => <ToolbarCustomizeRow key={dimension} id={dimension} label={`分组层级${browseLabels[dimension]}`}><span className="toolbar-layout-label">{index + 1}. {browseLabels[dimension]}</span></ToolbarCustomizeRow>)}</SortableContext></DndContext><span className="folder-menu-separator" /></>}
      <div className="catalog-group-menu-title">显示在工具栏</div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={() => { sorting.current = true; }} onDragCancel={() => { sorting.current = false; }} onDragEnd={({ active, over }) => { sorting.current = false; if (over) reorder(String(active.id), String(over.id)); }}>
      <SortableContext items={menuItems} strategy={verticalListSortingStrategy}>
      {menuItems.map((id) => <ToolbarCustomizeRow id={id} label={labelFor(id)} key={id}>
        {isDecoration(id) ? <><span className="toolbar-layout-label">{labelFor(id)}</span><button type="button" aria-label={`移除${labelFor(id)}`} title="移除" onClick={() => removeDecoration(id)}><X size={13} /></button></> : <label><input type="checkbox" checked={isDimension(id) ? visible.includes(id) : shownTools.includes(id)} onChange={() => toggleVisible(id)} />{labelFor(id)}</label>}
      </ToolbarCustomizeRow>)}
      </SortableContext>
      </DndContext>
      <button className="catalog-group-menu-disclosure" type="button" aria-expanded={exifOpen} onClick={() => setExifOpen((open) => !open)}>EXIF <ChevronDown size={13} className={exifOpen ? 'is-open' : ''} /></button>
      </div>
      <footer><button type="button" onClick={() => addDecoration('separator')}><Plus size={14} />分割线</button><button type="button" onClick={() => addDecoration('spacer')}><Plus size={14} />弹性空白</button><button type="button" onClick={() => {
        setToolbarOrder(allItems); setVisible([]); setShownTools(defaultTools);
        try { localStorage.setItem(orderKey, JSON.stringify(allItems)); localStorage.removeItem('photoallisai.catalog-filter-fields'); localStorage.removeItem(visibleToolsKey); localStorage.removeItem('photoallisai.catalog-toolbar-tools'); } catch { /* restricted storage */ }
      }}><RotateCcw size={13} />恢复默认</button></footer>
    </div></div>, document.body)}
  </div>;
}
