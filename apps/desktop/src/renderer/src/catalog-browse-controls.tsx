import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, CalendarDays, Check, ChevronDown, ChevronUp, Folder, Grid2X2, LoaderCircle, SlidersHorizontal } from 'lucide-react';
import { browseDimensions, browseLabels, defaultGroupOrder, type BrowseDimension, type BrowseFilters } from './catalog-browse';

const dimensions = Object.keys(browseDimensions) as BrowseDimension[];

export function CatalogBrowseControls({ value, onChange, pending = 0, total = 0 }: {
  value: BrowseFilters;
  onChange: (next: BrowseFilters) => void;
  pending?: number;
  total?: number;
}): React.JSX.Element {
  const [visible, setVisible] = useState<BrowseDimension[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('photoallisai.catalog-filter-fields') ?? 'null');
      if (Array.isArray(saved)) return dimensions.filter((dimension) => saved.includes(dimension));
    } catch { /* restricted storage */ }
    return ['date', 'folder'];
  });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [exifOpen, setExifOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element || !menu) return;
    const position = () => {
      element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - element.offsetWidth - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - element.offsetHeight - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    return () => observer.disconnect();
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); } };
    const resize = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', resize);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key, true); window.removeEventListener('resize', resize); };
  }, [menu]);
  const toggleGroup = (dimension: BrowseDimension) => onChange({ ...value, groupBy: value.groupBy.includes(dimension) ? value.groupBy.filter((item) => item !== dimension) : [...value.groupBy, dimension] });
  const toggleOrder = (dimension: BrowseDimension) => onChange({ ...value, groupOrder: { ...value.groupOrder, [dimension]: (value.groupOrder[dimension] ?? defaultGroupOrder(dimension)) === 'asc' ? 'desc' : 'asc' } });
  const moveGroup = (dimension: BrowseDimension, offset: number) => {
    const current = value.groupBy.indexOf(dimension);
    const next = current + offset;
    if (current < 0 || next < 0 || next >= value.groupBy.length) return;
    const groupBy = [...value.groupBy];
    [groupBy[current], groupBy[next]] = [groupBy[next]!, groupBy[current]!];
    onChange({ ...value, groupBy });
  };
  const openMenu = (x: number, y: number) => setMenu({ x, y });
  return <div className="catalog-browse-controls" role="group" aria-label="图库分组维度" onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); openMenu(event.clientX, event.clientY); }}>
    {[...value.groupBy, ...dimensions.filter((dimension) => visible.includes(dimension) && !value.groupBy.includes(dimension))].map((dimension) => {
      const active = value.groupBy.includes(dimension);
      const ascending = (value.groupOrder[dimension] ?? defaultGroupOrder(dimension)) === 'asc';
      const Icon = dimension === 'folder' ? Folder : dimension === 'format' ? Grid2X2 : ['date', 'month', 'year', 'exifDay', 'exifMonth', 'exifYear'].includes(dimension) ? CalendarDays : SlidersHorizontal;
      const label = browseLabels[dimension];
      return <span className={`catalog-facet${active ? ' is-active' : ''}`} key={dimension}>
        <button type="button" aria-label={`按${label}分组`} aria-pressed={active} title={['date', 'month', 'year'].includes(dimension) ? `按文件修改${label}分组` : `按${label}分组`} onClick={() => toggleGroup(dimension)}><Icon size={13} /><span>{label}</span></button>
        {active && <button className="catalog-facet-order" type="button" aria-label={`${label}：${ascending ? '正序' : '逆序'}，点击切换`} title={ascending ? '正序，点击改为逆序' : '逆序，点击改为正序'} onClick={() => toggleOrder(dimension)}>{ascending ? <ArrowUp size={13} /> : <ArrowDown size={13} />}</button>}
      </span>;
    })}
    <button className="catalog-facet-options" type="button" aria-label="配置图库分组字段" title="显示分组字段" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openMenu(rect.left, rect.bottom + 4); }}><ChevronDown size={12} /></button>
    {pending > 0 && <span className="catalog-group-loading" role="status" title="读取分组元数据"><LoaderCircle size={12} />{Math.max(0, total - pending)} / {total}</span>}
    {menu && createPortal(<div ref={menuRef} className="catalog-facet-popup folder-context-menu" role="menu" aria-label="显示分组字段" style={{ left: menu.x, top: menu.y }}>
      {value.groupBy.length > 1 && <><div className="catalog-group-menu-title">分组层级</div>{value.groupBy.map((dimension, index) => <div className="catalog-group-menu-order" key={dimension}><span>{index + 1}. {browseLabels[dimension]}</span><button type="button" aria-label={`上移${browseLabels[dimension]}`} disabled={index === 0} onClick={() => moveGroup(dimension, -1)}><ChevronUp size={13} /></button><button type="button" aria-label={`下移${browseLabels[dimension]}`} disabled={index === value.groupBy.length - 1} onClick={() => moveGroup(dimension, 1)}><ChevronDown size={13} /></button></div>)}<span className="folder-menu-separator" /></>}
      <div className="catalog-group-menu-title">显示在工具栏</div>
      {dimensions.filter((dimension) => browseDimensions[dimension].section === 'file').map((dimension) => <button type="button" role="menuitemcheckbox" aria-checked={visible.includes(dimension)} key={dimension} onClick={() => {
        const next = visible.includes(dimension) ? visible.filter((item) => item !== dimension) : [...visible, dimension];
        setVisible(next);
        try { localStorage.setItem('photoallisai.catalog-filter-fields', JSON.stringify(next)); } catch { /* restricted storage */ }
      }}><span className="menu-check-slot">{visible.includes(dimension) && <Check size={13} />}</span>{browseLabels[dimension]}</button>)}
      <button className="catalog-group-menu-disclosure" type="button" aria-expanded={exifOpen} onClick={() => setExifOpen((open) => !open)}>EXIF <ChevronDown size={13} className={exifOpen ? 'is-open' : ''} /></button>
      {exifOpen && dimensions.filter((dimension) => browseDimensions[dimension].section === 'exif').map((dimension) => <button type="button" role="menuitemcheckbox" aria-checked={visible.includes(dimension)} key={dimension} onClick={() => {
        const next = visible.includes(dimension) ? visible.filter((item) => item !== dimension) : [...visible, dimension];
        setVisible(next);
        try { localStorage.setItem('photoallisai.catalog-filter-fields', JSON.stringify(next)); } catch { /* restricted storage */ }
      }}><span className="menu-check-slot">{visible.includes(dimension) && <Check size={13} />}</span>{browseLabels[dimension]}</button>)}
    </div>, document.body)}
  </div>;
}
