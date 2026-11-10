import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export function ViewerZoomControl({ percent, title, onZoom, onCommand }: {
  percent: number;
  title: string;
  onZoom: (percent: number) => void;
  onCommand: (command: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setPosition(null);
    };
    const reposition = () => setPosition(null);
    document.addEventListener('pointerdown', close);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', reposition);
    };
  }, [position]);
  const commit = () => {
    if (draft !== null) {
      const value = Number(draft.replace(/%/g, '').trim());
      if (Number.isFinite(value) && value > 0) onZoom(value);
    }
    setDraft(null);
  };
  const command = (value: string) => {
    if (value.startsWith('zoom:')) onZoom(Number(value.slice(5)));
    else onCommand(value);
    setPosition(null);
    toggle.current?.focus();
  };
  const options = [
    ['fit', '适应窗口'], ['width', '适应宽度'], ['zoom:100', '100%'], ['zoom:50', '50%'], ['zoom:200', '200%'], ['fullscreen', '切换全屏'],
    ['background:neutral', '背景：跟随主题'], ['background:checker', '背景：透明棋盘格'], ['background:light', '背景：浅色'], ['background:dark', '背景：深色']
  ];
  return <div className="viewer-zoom-control" ref={root}>
    <input aria-label="缩放比例" title={title} inputMode="decimal" value={draft ?? `${percent}%`} onFocus={(event) => { setDraft(`${percent}%`); event.currentTarget.select(); }} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => {
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft(null); }
    }} />
    <button type="button" ref={toggle} aria-label="缩放与显示选项" title="缩放与显示选项" aria-haspopup="menu" aria-expanded={Boolean(position)} onClick={() => {
      const rect = root.current!.getBoundingClientRect();
      setPosition(position ? null : { left: Math.max(8, Math.min(rect.left, window.innerWidth - 200)), bottom: window.innerHeight - rect.top + 6 });
    }}><ChevronDown size={12} /></button>
    {position && createPortal(<div className="viewer-zoom-menu" role="menu" aria-label="缩放与显示选项" ref={menu} style={position} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); setPosition(null); toggle.current?.focus(); }
      if (event.key === 'Tab') setPosition(null);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    }}>{options.map(([value, label]) => <button type="button" role="menuitem" key={value} onClick={() => command(value!)}><span>{label}</span>{(value === 'fit' || value === 'zoom:100') && <kbd aria-hidden="true">{value === 'fit' ? 'F' : 'Z'}</kbd>}</button>)}</div>, document.body)}
  </div>;
}
