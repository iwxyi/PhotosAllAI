import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CatalogAsset,
  CatalogAlbum,
  CatalogSmartCollection,
  CatalogAssetCursor,
  CatalogFolder,
  CatalogTag,
  AnalysisRevision,
  GenerationResult,
  FileOperationHistoryItem,
  PersistedTask,
  PromptTemplate,
  ProviderProfile,
  SavePromptTemplateInput,
  SaveProviderProfileInput,
  WorkspaceSession,
  WorkspaceTab
} from '@photoallisai/contracts';
import { computeHorizontalWindow, composeGenerationPrompt, selectAll, updateSelection, type SelectionIntent, type SelectionState } from '@photoallisai/domain';
import {
  Aperture,
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Columns2,
  Command,
  Copy,
  Download,
  FilePenLine,
  Folder,
  FolderHeart,
  FolderInput,
  FolderOpen,
  GalleryHorizontalEnd,
  Grid2X2,
  History,
  Image,
  Info,
  KeyRound,
  Layers3,
  LibraryBig,
  ListFilter,
  Maximize2,
  PanelBottomOpen,
  Pause,
  Play,
  Plus,
  Search,
  Server,
  Settings,
  RotateCcw,
  Sparkles,
  Star,
  ShieldCheck,
  Tags,
  Trash2,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react';

import { photos, type Photo } from './mock-data';

type CompareMode = 'single' | 'split';

const tabs: { id: WorkspaceTab; label: string; icon: typeof Image }[] = [
  { id: 'library', label: '图库', icon: Image },
  { id: 'templates', label: '提示词模板', icon: WandSparkles },
  { id: 'tasks', label: '任务中心', icon: Clock3 },
  { id: 'settings', label: '设置', icon: Settings }
];

const demoFolders = [
  { name: '2026 人像作品', count: 128, selected: true },
  { name: '城市漫步', count: 84 },
  { name: '海岸与山野', count: 216 },
  { name: '待交付', count: 37 }
];

function mapCatalogAssets(assets: CatalogAsset[]): Photo[] {
  return assets.map((asset) => ({
    id: asset.id,
    folderId: asset.folderId,
    fileName: asset.fileName,
    src: asset.previewUrl,
    thumbnailSrc: asset.thumbnailUrl,
    format: asset.format,
    dimensions: `${(asset.sizeBytes / 1_048_576).toFixed(1)} MB`,
    rating: asset.rating,
    tags: asset.tags
  }));
}

function IconButton({
  label,
  children,
  active = false,
  onClick,
  disabled = false
}: {
  label: string;
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      className={`icon-button${active ? ' is-active' : ''}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      type="button"
    >
      {children}
    </button>
  );
}

function AppTabs({
  active,
  openTabs,
  onChange,
  onClose,
  onOpen
}: {
  active: WorkspaceTab;
  openTabs: WorkspaceTab[];
  onChange: (id: WorkspaceTab) => void;
  onClose: (id: WorkspaceTab) => void;
  onOpen: (id: WorkspaceTab) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const closedTabs = tabs.filter((tab) => !openTabs.includes(tab.id));
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.new-tab-control')) setMenuOpen(false);
    };
    window.addEventListener('keydown', close);
    window.addEventListener('pointerdown', closeOutside);
    return () => {
      window.removeEventListener('keydown', close);
      window.removeEventListener('pointerdown', closeOutside);
    };
  }, [menuOpen]);
  return (
    <div className="tab-strip" role="tablist" aria-label="工作区">
      {openTabs.map((tabId) => {
        const tab = tabs.find((item) => item.id === tabId)!;
        const Icon = tab.icon;
        return (
          <div
            key={tab.id}
            className={`workspace-tab${active === tab.id ? ' is-active' : ''}`}
          >
            <button className="tab-main" role="tab" aria-selected={active === tab.id} type="button" tabIndex={active === tab.id ? 0 : -1} onClick={() => onChange(tab.id)}><Icon size={14} /><span>{tab.label}</span></button>
            {tab.id !== 'library' && <button className="tab-close" type="button" aria-label={`关闭${tab.label}标签页`} onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}><X size={12} /></button>}
          </div>
        );
      })}
      <div className="new-tab-control">
        <IconButton label="打开工作区" disabled={closedTabs.length === 0} onClick={() => setMenuOpen((value) => !value)}><Plus size={15} /></IconButton>
        {menuOpen && <div className="new-tab-menu" role="menu">{closedTabs.map((tab) => { const Icon = tab.icon; return <button key={tab.id} type="button" role="menuitem" onClick={() => { onOpen(tab.id); setMenuOpen(false); }}><Icon size={14} /><span>{tab.label}</span></button>; })}</div>}
      </div>
    </div>
  );
}

function AppHeader({ active, openTabs, onChange, onClose, onOpen, onImport, search, onSearchChange }: { active: WorkspaceTab; openTabs: WorkspaceTab[]; onChange: (id: WorkspaceTab) => void; onClose: (id: WorkspaceTab) => void; onOpen: (id: WorkspaceTab) => void; onImport: () => void; search: string; onSearchChange: (value: string) => void }) {
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);
  return (
    <header className="app-header">
      <div className="titlebar-drag" />
      <div className="brand">
        <Aperture size={18} strokeWidth={1.7} />
        <span>PhotoAllIsAI</span>
      </div>
      <AppTabs active={active} openTabs={openTabs} onChange={onChange} onClose={onClose} onOpen={onOpen} />
      <div className="header-actions">
        <label className="search-trigger">
          <Search size={14} />
          <input ref={searchRef} aria-label="搜索图库" value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="搜索图库" />
          <kbd>⌘ K</kbd>
        </label>
        <IconButton label="导入文件夹" onClick={onImport}>
          <FolderOpen size={16} />
        </IconButton>
        <div className="sync-indicator" title="所有更改已保存">
          <Check size={13} />
        </div>
      </div>
    </header>
  );
}

function Sidebar({
  folders,
  albums,
  totalCount,
  selectedFolderId,
  selectedAlbumId,
  smartCollections,
  selectedSmartCollection,
  tags,
  selectedTagId,
  onSelectFolder,
  onSelectAlbum,
  onSelectSmartCollection,
  onRefreshAlbums,
  onSelectTag,
  isDemo
}: {
  folders: CatalogFolder[];
  albums: CatalogAlbum[];
  totalCount: number;
  selectedFolderId: string | null;
  selectedAlbumId: string | null;
  smartCollections: CatalogSmartCollection[];
  selectedSmartCollection: CatalogSmartCollection['id'] | null;
  tags: CatalogTag[];
  selectedTagId: string | null;
  onSelectFolder: (folderId: string | null) => void;
  onSelectAlbum: (albumId: string | null) => void;
  onSelectSmartCollection: (id: CatalogSmartCollection['id'] | null) => void;
  onRefreshAlbums: () => Promise<void>;
  onSelectTag: (tagId: string | null) => void;
  isDemo: boolean;
}): React.JSX.Element {
  const [albumManagerOpen, setAlbumManagerOpen] = useState(false);
  const [albumName, setAlbumName] = useState('');
  const [editingAlbumId, setEditingAlbumId] = useState<string | null>(null);
  const [albumBusy, setAlbumBusy] = useState(false);
  const visibleFolders = isDemo
    ? demoFolders.map((folder, index) => ({ id: `demo-${index}`, name: folder.name, assetCount: folder.count }))
    : folders;
  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
        <nav aria-label="图库导航">
          <button className={`nav-row${selectedFolderId === null ? ' is-active' : ''}`} type="button" onClick={() => onSelectFolder(null)}>
            <GalleryHorizontalEnd size={15} />
            <span>所有照片</span>
            <span className="row-count">{isDemo ? '12,408' : totalCount}</span>
          </button>
          <div className="nav-row">
            <Clock3 size={15} />
            <span>最近导入</span>
            <span className="row-count">248</span>
          </div>
          <div className="nav-row">
            <Star size={15} />
            <span>首选</span>
            <span className="row-count">86</span>
          </div>
        </nav>

        <div className="sidebar-section">
          <div className="section-heading">
            <span>文件夹</span>
            <button type="button" aria-label="添加文件夹"><Plus size={13} /></button>
          </div>
          {visibleFolders.map((folder) => (
            <button className={`nav-row folder-row${selectedFolderId === folder.id ? ' is-selected' : ''}`} type="button" key={folder.id} onClick={() => onSelectFolder(folder.id)}>
              <ChevronRight className="disclosure" size={12} />
              <Folder size={15} />
              <span>{folder.name}</span>
              <span className="row-count">{folder.assetCount}</span>
            </button>
          ))}
        </div>

        {!isDemo && <div className="sidebar-section"><div className="section-heading"><span>相册</span><button type="button" aria-label="管理相册" onClick={() => { setAlbumManagerOpen(true); setEditingAlbumId(null); setAlbumName(''); }}><Plus size={13} /></button></div>{albums.length === 0 ? <small className="sidebar-empty">暂无相册</small> : albums.map((album) => <button className={`nav-row folder-row${selectedAlbumId === album.id ? ' is-selected' : ''}`} type="button" key={album.id} onClick={() => onSelectAlbum(selectedAlbumId === album.id ? null : album.id)}><FolderHeart size={15} /><span>{album.name}</span><span className="row-count">{album.assetCount}</span></button>)}</div>}

        <div className="sidebar-section">
          <div className="section-heading"><span>智能集合</span></div>
          {(isDemo ? [{ id: 'unanalyzed', assetCount: 43 }, { id: 'favorites', assetCount: 86 }, { id: 'generated', assetCount: 27 }] : smartCollections).map((collection) => { const label = collection.id === 'favorites' ? '首选照片' : collection.id === 'unrated' ? '未评分' : collection.id === 'unanalyzed' ? '等待 AI 分析' : '已生成'; const Icon = collection.id === 'favorites' ? Star : collection.id === 'generated' ? FolderHeart : collection.id === 'unrated' ? CircleAlert : Sparkles; return <button className={`nav-row${selectedSmartCollection === collection.id ? ' is-active' : ''}`} type="button" key={collection.id} onClick={() => onSelectSmartCollection(selectedSmartCollection === collection.id ? null : collection.id as CatalogSmartCollection['id'])}><Icon size={15} /><span>{label}</span><span className="row-count">{collection.assetCount}</span></button>; })}
        </div>

        <div className="sidebar-section">
          <div className="section-heading"><span>标签</span><button type="button" aria-label="管理标签"><Tags size={13} /></button></div>
          <div className="tag-cloud">
            {isDemo ? <><span>人像</span><span>夜景</span><span>街拍</span><span>自然光</span></> : tags.length === 0 ? <small>暂无标签</small> : tags.map((tag) => <button className={selectedTagId === tag.id ? 'is-active' : ''} type="button" key={tag.id} onClick={() => onSelectTag(selectedTagId === tag.id ? null : tag.id)}>{tag.name}<em>{tag.assetCount}</em></button>)}
          </div>
        </div>
      </div>
      <div className="storage-meter">
        <div><span>图库存储</span><span>184 GB / 500 GB</span></div>
        <div className="meter"><i /></div>
      </div>
      {albumManagerOpen && <div className="modal-backdrop sidebar-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !albumBusy) setAlbumManagerOpen(false); }}><form className="album-dialog" role="dialog" aria-modal="true" aria-labelledby="album-dialog-title" onSubmit={async (event) => { event.preventDefault(); if (!albumName.trim() || albumBusy) return; setAlbumBusy(true); try { await window.desktopApi.saveCatalogAlbum({ id: editingAlbumId ?? undefined, name: albumName }); await onRefreshAlbums(); setAlbumName(''); setEditingAlbumId(null); } finally { setAlbumBusy(false); } }}><header><div><span className="dialog-icon"><FolderHeart size={16} /></span><div><h2 id="album-dialog-title">管理相册</h2><p>相册只管理图库关系，不会移动原文件。</p></div></div><IconButton label="关闭相册管理" onClick={() => setAlbumManagerOpen(false)}><X size={15} /></IconButton></header><div className="album-list">{albums.map((album) => <div className={`album-row${editingAlbumId === album.id ? ' is-selected' : ''}`} key={album.id}><button type="button" onClick={() => { setEditingAlbumId(album.id); setAlbumName(album.name); }}><FolderHeart size={14} /><span>{album.name}</span><small>{album.assetCount} 张</small></button><button type="button" aria-label={`删除相册 ${album.name}`} onClick={async () => { if (albumBusy) return; setAlbumBusy(true); try { await window.desktopApi.deleteCatalogAlbum(album.id); if (selectedAlbumId === album.id) onSelectAlbum(null); await onRefreshAlbums(); } finally { setAlbumBusy(false); } }}><Trash2 size={13} /></button></div>)}</div><label className="album-field"><span>{editingAlbumId ? '重命名相册' : '新建相册'}</span><input autoFocus value={albumName} maxLength={120} placeholder="例如：客户交付" onChange={(event) => setAlbumName(event.target.value)} /></label><footer><button className="quiet-button" type="button" onClick={() => setAlbumManagerOpen(false)}>关闭</button><button className="primary-action compact" type="submit" disabled={!albumName.trim() || albumBusy}>{editingAlbumId ? '保存名称' : '创建相册'}</button></footer></form></div>}
    </aside>
  );
}

function Filmstrip({
  items,
  selected,
  selection,
  onSelect,
  collectionName,
  totalCount,
  hasMore,
  loading,
  onLoadMore
}: {
  items: Photo[];
  selected: Photo;
  selection: SelectionState;
  onSelect: (photo: Photo, intent: SelectionIntent) => void;
  collectionName: string;
  totalCount: number;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, scrollLeft: 0 });
  const itemSize = 137;
  const virtual = computeHorizontalWindow(items.length, itemSize, viewport.width, viewport.scrollLeft, 4);
  const visibleItems = items.slice(virtual.start, virtual.end);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const updateWidth = () => setViewport((current) => ({ ...current, width: element.clientWidth }));
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="filmstrip-region">
      <div className="filmstrip-toolbar">
        <div className="result-summary"><strong>{collectionName}</strong><span>{totalCount} 张照片</span></div>
        <div className="filmstrip-tools">
          <button className="quiet-button" type="button"><ListFilter size={14} /> 筛选</button>
          <button className="quiet-button" type="button">拍摄时间 <ChevronDown size={12} /></button>
          <div className="segmented-control">
            <button className="is-active" type="button" aria-label="胶片视图"><GalleryHorizontalEnd size={14} /></button>
            <button type="button" aria-label="网格视图"><Grid2X2 size={14} /></button>
          </div>
        </div>
      </div>
      <div className="filmstrip" role="listbox" aria-label="照片" ref={viewportRef} onScroll={(event) => {
        const element = event.currentTarget;
        setViewport((current) => ({ ...current, scrollLeft: element.scrollLeft }));
        if (hasMore && !loading && element.scrollLeft + element.clientWidth >= element.scrollWidth - itemSize * 3) onLoadMore();
      }}>
        <div className="filmstrip-track" style={{ width: virtual.totalSize + (hasMore ? itemSize : 0) }}>
        {visibleItems.map((photo, visibleIndex) => {
          const index = virtual.start + visibleIndex;
          return (
          <button
            className={`thumb${selected.id === photo.id ? ' is-selected' : ''}`}
            key={photo.id}
            style={{ left: index * itemSize }}
            onClick={(event) => onSelect(
              photo,
              event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'replace'
            )}
            role="option"
            aria-selected={selection.selectedIds.has(photo.id)}
            type="button"
          >
            <span className="raw-placeholder"><Image size={22} /><small>{photo.format}</small></span>
            {photo.thumbnailSrc || photo.src ? <img src={photo.thumbnailSrc ?? photo.src} alt="" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : null}
            <span className="thumb-index">{index + 1}</span>
            {photo.status && <i className={`status-dot status-${photo.status}`} />}
            {selection.selectedIds.has(photo.id) && <span className="selection-check"><Check size={11} /></span>}
            <span className="thumb-name">{photo.fileName}</span>
          </button>
          );
        })}
        {hasMore && <button className="filmstrip-more" type="button" style={{ left: items.length * itemSize }} onClick={onLoadMore} disabled={loading}>{loading ? '加载中' : '更多'}</button>}
        </div>
      </div>
    </section>
  );
}

function Viewer({
  photo,
  results,
  isDemo,
  onExport,
  onRate,
  onRegenerate,
  onEditTags,
  onMove,
  onCopy,
  onRename,
  onRemove,
  onTrash
}: {
  photo: Photo;
  results: GenerationResult[];
  isDemo: boolean;
  onExport: (resultIds: string[]) => Promise<string>;
  onRate: (rating: number) => void;
  onRegenerate: (result: GenerationResult) => Promise<string>;
  onEditTags: () => void;
  onMove: () => void;
  onCopy: () => void;
  onRename: () => void;
  onRemove: () => void;
  onTrash: () => void;
}): React.JSX.Element {
  const [compareMode, setCompareMode] = useState<CompareMode>('single');
  const [split, setSplit] = useState(52);
  const [showOriginal, setShowOriginal] = useState(false);
  const [selectedResultId, setSelectedResultId] = useState<string | null>(results[0]?.id ?? null);
  const [exportNotice, setExportNotice] = useState('');
  const latestResultId = results[0]?.id ?? null;
  const selectedResult = selectedResultId ? results.find((result) => result.id === selectedResultId) : undefined;
  const generatedSource = isDemo ? photo.src : selectedResult?.resultUrl;

  useEffect(() => {
    setSelectedResultId(latestResultId);
  }, [photo.id, latestResultId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (event.key.toLowerCase() === 'o') setShowOriginal(event.type === 'keydown');
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);

  return (
    <section className="viewer">
      <div className="viewer-toolbar">
        <div className="viewer-title">
          <span>{photo.fileName}</span>
          <i>{selectedResult ? `生成版本 ${selectedResult.version}` : isDemo ? '生成版本 2' : '原图'}</i>
        </div>
        <div className="viewer-actions">
          <div className="segmented-control labeled">
            <button
              className={compareMode === 'single' ? 'is-active' : ''}
              onClick={() => setCompareMode('single')}
              type="button"
            >
              单图
            </button>
            <button
              className={compareMode === 'split' ? 'is-active' : ''}
              onClick={() => setCompareMode('split')}
              type="button"
            >
              <Columns2 size={13} /> 对比
            </button>
          </div>
          <IconButton label="缩小"><ZoomOut size={15} /></IconButton>
          <span className="zoom-value">38%</span>
          <IconButton label="放大"><ZoomIn size={15} /></IconButton>
          <IconButton label="适应窗口"><Maximize2 size={15} /></IconButton>
        </div>
      </div>
      <div className="canvas-wrap">
        <div className={`photo-canvas${compareMode === 'split' ? ' is-comparing' : ''}`}>
          <div className="preview-unavailable"><Image size={36} /><strong>预览暂不可用</strong><span>图像服务将在后台生成屏幕预览</span></div>
          {photo.src ? <img className="base-image" src={photo.src} alt={photo.fileName} onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : null}
          {generatedSource && !showOriginal && (
            <div
              className="generated-layer"
              style={compareMode === 'split' ? { clipPath: `inset(0 ${100 - split}% 0 0)` } : undefined}
            >
              <img src={generatedSource} alt="AI 生成版本" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
            </div>
          )}
          {compareMode === 'split' && (
            <>
              <input
                className="compare-input"
                type="range"
                min="0"
                max="100"
                value={split}
                aria-label="调整原图和生成图分割线"
                onChange={(event) => setSplit(Number(event.target.value))}
              />
              <div className="compare-line" style={{ left: `${split}%` }}><span><Columns2 size={13} /></span></div>
              <span className="image-label original-label">生成版本</span>
              <span className="image-label result-label">原图</span>
            </>
          )}
        </div>
      </div>
      <div className="viewer-footer">
        <div className="viewer-meta-actions"><div className="rating">{[1, 2, 3, 4, 5].map((value) => <button type="button" aria-label={`设置评分 ${value}`} key={value} onClick={() => onRate(photo.rating === value ? 0 : value)}><Star size={13} fill={value <= photo.rating ? 'currentColor' : 'none'} /></button>)}</div>{!isDemo && <><IconButton label="重命名照片" onClick={onRename}><FilePenLine size={13} /></IconButton><IconButton label="复制到文件夹" onClick={onCopy}><Copy size={13} /></IconButton><IconButton label="移动到文件夹" onClick={onMove}><FolderInput size={13} /></IconButton><IconButton label="仅从图库移除" onClick={onRemove}><LibraryBig size={13} /></IconButton><IconButton label="移到系统回收站" onClick={onTrash}><Trash2 size={13} /></IconButton></>}<IconButton label="添加标签" onClick={onEditTags}><Tags size={13} /></IconButton></div>
        <div className="version-switcher">
          <button type="button" onMouseDown={() => setShowOriginal(true)} onMouseUp={() => setShowOriginal(false)} onMouseLeave={() => setShowOriginal(false)}>
            按住查看原图 <kbd>O</kbd>
          </button>
          <span />
          <button className={!selectedResult && !isDemo ? 'is-current' : ''} type="button" onClick={() => setSelectedResultId(null)}>原图</button>
          {isDemo ? <><button type="button">V1</button><button className="is-current" type="button">V2</button></> : [...results].reverse().map((result) => (
            <button className={selectedResult?.id === result.id ? 'is-current' : ''} type="button" key={result.id} onClick={() => setSelectedResultId(result.id)}>V{result.version}</button>
          ))}
          <button type="button" title="按当前方案再次生成" aria-label="按当前方案再次生成" disabled={!selectedResult || isDemo} onClick={() => {
            if (!selectedResult) return;
            void onRegenerate(selectedResult).then(setExportNotice);
          }}><RotateCcw size={13} /></button>
          <button type="button" title="导出当前版本" aria-label="导出当前版本" disabled={!selectedResult || isDemo} onClick={() => {
            if (!selectedResult) return;
            void onExport([selectedResult.id]).then(setExportNotice);
          }}><Download size={13} /></button>
          {exportNotice && <em className="viewer-notice" role="status">{exportNotice}</em>}
        </div>
        <div className="file-meta"><span>{photo.format}</span><span>{photo.dimensions}</span></div>
      </div>
    </section>
  );
}

function AiPanel({
  revision,
  isDemo,
  notice,
  onAnalyze,
  generationProfiles,
  templates,
  onGenerate
}: {
  revision: AnalysisRevision | undefined;
  isDemo: boolean;
  notice: string;
  onAnalyze: () => void;
  generationProfiles: ProviderProfile[];
  templates: PromptTemplate[];
  onGenerate: (input: { providerProfileId: string; template: PromptTemplate | null; count: number; instruction: string; disabledActionIds: Set<string> }) => Promise<string>;
}): React.JSX.Element {
  const [actions, setActions] = useState({ people: true, light: true, texture: false });
  const [disabledActions, setDisabledActions] = useState<Set<string>>(new Set());
  const [generationCount, setGenerationCount] = useState(3);
  const [templateId, setTemplateId] = useState('');
  const [instruction, setInstruction] = useState('保持自然皮肤纹理，不要过度磨皮。');
  const [generationNotice, setGenerationNotice] = useState('');
  const [generating, setGenerating] = useState(false);

  const toggle = (key: keyof typeof actions) => setActions((current) => ({ ...current, [key]: !current[key] }));
  const result = revision?.result;
  const score = isDemo ? 86 : result ? Math.round(result.quality.overallScore) : '--';
  const summary = isDemo ? '自然光人像' : result?.summary ?? '等待视觉分析';
  const description = isDemo ? '主体清晰，背景存在干扰元素' : result ? result.catalog.shortDescription : '尚未生成分析与编目数据';
  const enabledActionCount = isDemo
    ? Object.values(actions).filter(Boolean).length
    : result?.generativeActions.filter((action) => action.enabled && !disabledActions.has(action.id)).length ?? 0;
  const selectedTemplate = templates.find((template) => template.id === templateId) ?? null;

  const queueGeneration = async () => {
    if (isDemo) return;
    const profile = generationProfiles[0];
    if (!profile) {
      setGenerationNotice('请先在设置中添加并启用图片生成模型。');
      return;
    }
    setGenerating(true);
    try {
      setGenerationNotice(await onGenerate({
        providerProfileId: profile.id,
        template: selectedTemplate,
        count: generationCount,
        instruction,
        disabledActionIds: disabledActions
      }));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <aside className="inspector">
      <div className="inspector-tabs"><button className="is-active" type="button"><Bot size={14} />AI</button><button type="button"><Info size={14} />信息</button><button type="button"><Layers3 size={14} />版本</button></div>
      <div className="inspector-scroll">
        <div className="analysis-head">
          <div className="analysis-score"><span>AI</span><strong>{score}</strong></div>
          <div><strong>{summary}</strong><p>{description}</p></div>
          <span className="confidence">{result || isDemo ? '分析完成' : '未分析'}</span>
        </div>

        <div className="inspector-section">
          <div className="inspector-heading"><span>视觉分析</span>{!isDemo && <button type="button" onClick={onAnalyze}>{result ? '重新分析' : '开始分析'}</button>}</div>
          <p className="analysis-copy">{isDemo ? '柔和侧光塑造了自然肤色。建议保留浅景深和发丝细节，同时清理右后方路人并轻微提亮面部。' : result?.report ?? (notice || '选择已配置的视觉模型后开始分析。')}</p>
          {isDemo ? <><div className="issue-row"><i className="severity high" /><span>背景路人分散注意力</span><em>严重</em></div><div className="issue-row"><i className="severity medium" /><span>面部中间调略暗</span><em>中等</em></div></> : result?.quality.issues.map((issue) => <div className="issue-row" key={`${issue.type}-${issue.description}`}><i className={`severity ${issue.severity >= 0.7 ? 'high' : 'medium'}`} /><span>{issue.description}</span><em>{Math.round(issue.confidence * 100)}%</em></div>)}
        </div>

        <div className="inspector-section">
          <div className="inspector-heading"><span>AI 编辑动作</span><span className="section-count">{enabledActionCount} 项已启用</span></div>
          {isDemo ? <><ActionToggle title="清除背景路人" detail="自然补全街道与光影" risk="低风险" checked={actions.people} onChange={() => toggle('people')} /><ActionToggle title="优化人物光线" detail="保持身份和肤色不变" risk="低风险" checked={actions.light} onChange={() => toggle('light')} /><ActionToggle title="增强衣物纹理" detail="避免改变服装结构" risk="低风险" checked={actions.texture} onChange={() => toggle('texture')} /></> : result?.generativeActions.map((action) => <ActionToggle key={action.id} title={action.target} detail={action.instruction} risk={`${action.risk === 'high' ? '高' : action.risk === 'medium' ? '中' : '低'}风险`} checked={action.enabled && !disabledActions.has(action.id)} onChange={() => setDisabledActions((current) => { const next = new Set(current); if (next.has(action.id)) next.delete(action.id); else next.add(action.id); return next; })} />)}
          {!isDemo && !result && <div className="inline-empty">分析后将显示清除路人、移除障碍物等建议</div>}
        </div>

        <div className="inspector-section">
          <div className="inspector-heading"><span>提示词模板</span><button type="button">浏览模板</button></div>
          {isDemo ? <button className="template-choice" type="button"><span className="template-preview"><img src="./demo/portrait.jpg" alt="" /></span><span><strong>自然人像 · 清洁背景</strong><small>保留身份、服装与真实光线</small></span><ChevronRight size={15} /></button> : (
            <select className="template-select" aria-label="生成提示词模板" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
              <option value="">通用 AI 修图</option>
              {templates.map((template) => <option value={template.id} key={template.id}>{template.name} · V{template.version}</option>)}
            </select>
          )}
          <label className="instruction-field">
            <span>补充要求</span>
            <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={3} />
          </label>
          {!isDemo && generationNotice && <p className="generation-notice">{generationNotice}</p>}
        </div>
      </div>
      <div className="generate-footer">
        <div className="generation-count"><span>生成数量</span><div><button type="button" aria-label="减少生成数量" onClick={() => setGenerationCount((value) => Math.max(1, value - 1))}>−</button><strong>{generationCount}</strong><button type="button" aria-label="增加生成数量" onClick={() => setGenerationCount((value) => Math.min(8, value + 1))}>+</button></div></div>
        <button className="primary-action" type="button" onClick={() => void queueGeneration()} disabled={!isDemo && (!result || generating)}><Sparkles size={16} />{generating ? '正在加入…' : '加入生成队列'}</button>
      </div>
    </aside>
  );
}

function ActionToggle({ title, detail, risk, checked, onChange }: { title: string; detail: string; risk: string; checked: boolean; onChange: () => void }): React.JSX.Element {
  return (
    <button className="action-toggle" type="button" aria-pressed={checked} onClick={onChange}>
      <span className={`check-box${checked ? ' is-checked' : ''}`}>{checked && <Check size={12} />}</span>
      <span><strong>{title}</strong><small>{detail}</small></span>
      <span className="risk-chip">{risk}</span>
    </button>
  );
}

function TaskBar({ open, onToggle, tasks }: { open: boolean; onToggle: () => void; tasks: PersistedTask[] | null }): React.JSX.Element {
  const isDemo = tasks === null;
  const visibleTasks = tasks ?? [];
  const runningCount = isDemo ? 1 : visibleTasks.filter((task) => ['preparing', 'uploading', 'processing', 'downloading', 'saving'].includes(task.status)).length;
  const waitingCount = isDemo ? 4 : visibleTasks.filter((task) => task.status === 'queued').length;
  const failedCount = isDemo ? 1 : visibleTasks.filter((task) => task.status === 'failed').length;

  return (
    <>
      {open && (
        <div className="task-drawer">
          <div className="drawer-head"><div><strong>当前任务</strong><span>生成任务将按顺序执行</span></div><div><button className="quiet-button" type="button"><Pause size={13} />暂停全部</button><IconButton label="关闭任务抽屉" onClick={onToggle}><X size={15} /></IconButton></div></div>
          {isDemo ? <><div className="task-row is-running"><span className="drag-handle">⠿</span><img src="./demo/portrait.jpg" alt="" /><span className="task-title"><strong>DSC_4821.NEF</strong><small>自然人像 · 清洁背景</small></span><span className="task-progress"><i style={{ width: '64%' }} /><em>正在生成 · 64%</em></span><span className="task-time">约 18 秒</span><IconButton label="暂停"><Pause size={14} /></IconButton></div><div className="task-row"><span className="drag-handle">⠿</span><img src="./demo/coast.jpg" alt="" /><span className="task-title"><strong>A7R_0938.ARW</strong><small>自然风光 · 清除游客</small></span><span className="queued-label">队列第 1 位</span><span className="task-time">生成 2 次</span><IconButton label="开始"><Play size={14} /></IconButton></div></> : visibleTasks.length === 0 ? <div className="drawer-empty">暂无任务</div> : visibleTasks.slice(0, 2).map((task) => <div className="task-row" key={task.id}><span className="drag-handle">⠿</span><span className="task-placeholder-image"><TaskKindIcon kind={task.kind} /></span><span className="task-title"><strong>{taskLabels[task.kind]}</strong><small>{task.assetId ?? '批量任务'}</small></span><span className="task-progress"><i style={{ width: `${task.progress * 100}%` }} /><em>{statusLabels[task.status]} · {Math.round(task.progress * 100)}%</em></span><span className="task-time">第 {task.attempt + 1} 次</span><span /></div>)}
        </div>
      )}
      <button className="task-statusbar" type="button" onClick={onToggle} aria-expanded={open}>
        <span className={`working-pulse${runningCount === 0 ? ' is-idle' : ''}`} /><strong>处理中 {runningCount}</strong><span>等待 {waitingCount}</span><span className="failed-count">失败 {failedCount}</span><span className="status-spacer" /><span>串行任务</span><PanelBottomOpen size={15} className={open ? 'is-open' : ''} />
      </button>
    </>
  );
}

type LibraryWorkspaceProps = {
  availablePhotos: Photo[];
  catalogFolders: CatalogFolder[];
  catalogAlbums: CatalogAlbum[];
  catalogSmartCollections: CatalogSmartCollection[];
  catalogTags: CatalogTag[];
  isDemo: boolean;
  selectedFolderId: string | null;
  selectedAlbumId: string | null;
  selectedSmartCollection: CatalogSmartCollection['id'] | null;
  selectedTagId: string | null;
  totalCount: number;
  hasMore: boolean;
  loadingMore: boolean;
  onSelectFolder: (folderId: string | null) => void;
  onSelectAlbum: (albumId: string | null) => void;
  onSelectSmartCollection: (id: CatalogSmartCollection['id'] | null) => void;
  onRefreshAlbums: () => Promise<void>;
  onSelectTag: (tagId: string | null) => void;
  onLoadMore: () => void;
  searchQuery: string;
  selectedAssetId: string | null;
  onSelectedAssetChange: (assetId: string | null) => void;
  onRefreshCatalog: () => Promise<void>;
};

function LibraryWorkspace(props: LibraryWorkspaceProps): React.JSX.Element {
  const [operationNotice, setOperationNotice] = useState('');
  if (props.availablePhotos.length > 0) {
    return <PopulatedLibraryWorkspace {...props} operationNotice={operationNotice} setOperationNotice={setOperationNotice} />;
  }
  return (
    <div className="workspace">
      <Sidebar folders={props.catalogFolders} albums={props.catalogAlbums} smartCollections={props.catalogSmartCollections} totalCount={props.totalCount} selectedFolderId={props.selectedFolderId} selectedAlbumId={props.selectedAlbumId} selectedSmartCollection={props.selectedSmartCollection} tags={props.catalogTags} selectedTagId={props.selectedTagId} onSelectFolder={props.onSelectFolder} onSelectAlbum={props.onSelectAlbum} onSelectSmartCollection={props.onSelectSmartCollection} onRefreshAlbums={props.onRefreshAlbums} onSelectTag={props.onSelectTag} isDemo={props.isDemo} />
      <main className="empty-library-main">
        <Search size={30} />
        <h2>{props.searchQuery ? '没有匹配的照片' : '此集合为空'}</h2>
        <p>{props.searchQuery ? '尝试其他文件名、场景、主体或 AI 关键词。' : '从其他目录选择照片，或导入新的照片文件夹。'}</p>
      </main>
      <aside className="empty-library-inspector"><Info size={18} /><span>选择照片后显示分析和版本信息</span></aside>
      {operationNotice && <div className="operation-toast" role="status">{operationNotice}<button type="button" aria-label="关闭提示" onClick={() => setOperationNotice('')}><X size={13} /></button></div>}
      <TaskBar open={false} onToggle={() => undefined} tasks={[]} />
    </div>
  );
}

type PopulatedLibraryWorkspaceProps = LibraryWorkspaceProps & {
  operationNotice: string;
  setOperationNotice: (notice: string) => void;
};

function PopulatedLibraryWorkspace({
  availablePhotos,
  catalogFolders,
  catalogAlbums,
  catalogSmartCollections,
  catalogTags,
  isDemo,
  selectedFolderId,
  selectedAlbumId,
  selectedSmartCollection,
  selectedTagId,
  totalCount,
  hasMore,
  loadingMore,
  onSelectFolder,
  onSelectAlbum,
  onSelectSmartCollection,
  onRefreshAlbums,
  onSelectTag,
  onLoadMore,
  searchQuery,
  selectedAssetId,
  onSelectedAssetChange,
  onRefreshCatalog,
  operationNotice,
  setOperationNotice
}: PopulatedLibraryWorkspaceProps): React.JSX.Element {
  const initialSelectedId = availablePhotos.some((photo) => photo.id === selectedAssetId)
    ? selectedAssetId!
    : availablePhotos[0]!.id;
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const [selection, setSelection] = useState<SelectionState>({
    selectedIds: new Set([initialSelectedId]),
    anchorId: initialSelectedId,
    focusId: initialSelectedId
  });
  const [tasksOpen, setTasksOpen] = useState(false);
  const [visionProfiles, setVisionProfiles] = useState<ProviderProfile[]>([]);
  const [generationProfiles, setGenerationProfiles] = useState<ProviderProfile[]>([]);
  const [templateItems, setTemplateItems] = useState<PromptTemplate[]>([]);
  const [analysisRevision, setAnalysisRevision] = useState<AnalysisRevision>();
  const [generationResults, setGenerationResults] = useState<GenerationResult[]>([]);
  const [analysisNotice, setAnalysisNotice] = useState('');
  const [taskItems, setTaskItems] = useState<PersistedTask[]>([]);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [folderAction, setFolderAction] = useState<'move' | 'copy'>('move');
  const [moveTargetFolderId, setMoveTargetFolderId] = useState('');
  const [moveBusy, setMoveBusy] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [removalMode, setRemovalMode] = useState<'remove' | 'trash' | null>(null);
  const [removalBusy, setRemovalBusy] = useState(false);
  const [albumTargetId, setAlbumTargetId] = useState('');
  const selected = availablePhotos.find((photo) => photo.id === selectedId) ?? availablePhotos[0]!;
  const orderedIds = useMemo(() => availablePhotos.map((photo) => photo.id), [availablePhotos]);
  const collectionName = selectedFolderId
    ? catalogFolders.find((folder) => folder.id === selectedFolderId)?.name ?? '文件夹'
    : selectedAlbumId
      ? catalogAlbums.find((album) => album.id === selectedAlbumId)?.name ?? '相册'
      : isDemo ? '2026 人像作品' : searchQuery ? `搜索：${searchQuery}` : '所有照片';

  useEffect(() => {
    if (selectedAssetId !== selectedId) onSelectedAssetChange(selectedId);
  }, [onSelectedAssetChange, selectedAssetId, selectedId]);

  useEffect(() => {
    if (availablePhotos.some((photo) => photo.id === selectedId)) return;
    const first = availablePhotos[0];
    if (!first) return;
    setSelectedId(first.id);
    onSelectedAssetChange(first.id);
    setSelection({ selectedIds: new Set([first.id]), anchorId: first.id, focusId: first.id });
  }, [availablePhotos, onSelectedAssetChange, selectedId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
        event.preventDefault();
        setSelection(selectAll(orderedIds));
      } else if (!isDemo && /^[0-5]$/.test(event.key)) {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
        event.preventDefault();
        const assetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
        void window.desktopApi.updateCatalogMetadata({ assetIds, rating: Number(event.key) }).then(onRefreshCatalog);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isDemo, onRefreshCatalog, orderedIds, selected.id, selection.selectedIds]);

  useEffect(() => {
    if (isDemo) return;
    void Promise.all([window.desktopApi.listProviderProfiles(), window.desktopApi.listPromptTemplates()]).then(([profiles, savedTemplates]) => {
      setVisionProfiles(profiles.filter((profile) => profile.purpose === 'vision' && profile.enabled));
      setGenerationProfiles(profiles.filter((profile) => profile.purpose === 'generation' && profile.enabled));
      setTemplateItems(savedTemplates);
    });
  }, [isDemo]);

  useEffect(() => {
    if (isDemo) return;
    let active = true;
    const refresh = () => {
      void window.desktopApi.listAnalysisRevisions(selected.id).then((items) => {
        if (active) setAnalysisRevision(items[0]);
      });
    };
    setAnalysisRevision(undefined);
    refresh();
    const interval = window.setInterval(refresh, 2_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [isDemo, selected.id]);

  useEffect(() => {
    if (isDemo) return;
    let active = true;
    const refresh = () => {
      void window.desktopApi.listGenerationResults(selected.id).then((items) => {
        if (active) setGenerationResults(items);
      });
    };
    setGenerationResults([]);
    refresh();
    const interval = window.setInterval(refresh, 1_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [isDemo, selected.id]);

  useEffect(() => {
    if (isDemo) return;
    let active = true;
    const refresh = () => { void window.desktopApi.listTasks().then((items) => { if (active) setTaskItems(items); }); };
    refresh();
    const interval = window.setInterval(refresh, 1_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [isDemo]);

  const selectPhoto = (photo: Photo, intent: SelectionIntent) => {
    setSelectedId(photo.id);
    onSelectedAssetChange(photo.id);
    setSelection((current) => updateSelection(current, orderedIds, photo.id, intent));
  };

  const analyzeSelection = async () => {
    const profile = visionProfiles[0];
    if (!profile) {
      setAnalysisNotice('请先在设置中添加并启用视觉分析模型。');
      return;
    }
    const targetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
    await Promise.all(targetIds.map((assetId) => window.desktopApi.enqueueTask({
      kind: 'analysis',
      assetId,
      payload: { providerProfileId: profile.id, mode: 'full' }
    })));
    setAnalysisNotice(`已将 ${targetIds.length} 张照片加入分析队列。`);
  };

  const rateSelection = async (rating: number) => {
    if (isDemo) return;
    const assetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
    await window.desktopApi.updateCatalogMetadata({ assetIds, rating });
    await onRefreshCatalog();
  };

  const generateSelection = async ({
    providerProfileId,
    template,
    count,
    instruction,
    disabledActionIds
  }: {
    providerProfileId: string;
    template: PromptTemplate | null;
    count: number;
    instruction: string;
    disabledActionIds: Set<string>;
  }): Promise<string> => {
    const targetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
    const batchId = crypto.randomUUID();
    let queued = 0;
    let skipped = 0;
    for (const assetId of targetIds) {
      const revisions = assetId === selected.id && analysisRevision
        ? [analysisRevision]
        : await window.desktopApi.listAnalysisRevisions(assetId);
      const revision = revisions[0];
      if (!revision) {
        skipped += 1;
        continue;
      }
      const analysis = {
        ...revision.result,
        generativeActions: revision.result.generativeActions.map((action) => ({
          ...action,
          enabled: action.enabled && (assetId !== selected.id || !disabledActionIds.has(action.id))
        }))
      };
      const prompt = composeGenerationPrompt({
        templateBody: template?.body ?? [
          '请基于原图进行专业且写实的修图。',
          '画面分析：{{analysis.summary}}',
          '编辑动作：\n{{analysis.generative_actions}}',
          '补充要求：{{user_instruction}}',
          '必须保留：\n{{preservation_rules}}'
        ].join('\n'),
        analysis,
        userInstruction: instruction
      });
      for (let resultIndex = 1; resultIndex <= count; resultIndex += 1) {
        await window.desktopApi.enqueueTask({
          kind: 'generation',
          assetId,
          payload: {
            providerProfileId,
            batchId,
            prompt,
            templateId: template?.id ?? null,
            templateVersion: template?.version ?? null,
            resultIndex
          }
        });
        queued += 1;
      }
    }
    setTasksOpen(true);
    return skipped > 0
      ? `已加入 ${queued} 个生成任务；${skipped} 张照片因尚未分析而跳过。`
      : `已加入 ${queued} 个生成任务。`;
  };

  const exportResults = async (resultIds: string[]): Promise<string> => {
    try {
      const report = await window.desktopApi.exportGenerationResults({ resultIds });
      if (report.canceled) return '已取消导出';
      return report.failed > 0
        ? `已导出 ${report.succeeded} 个文件，${report.failed} 个失败`
        : `已导出 ${report.succeeded} 个文件`;
    } catch {
      return '导出失败，请检查目录权限和可用空间。';
    }
  };

  const exportLatestSelection = async () => {
    const targetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
    const lists = await Promise.all(targetIds.map((assetId) =>
      assetId === selected.id ? Promise.resolve(generationResults) : window.desktopApi.listGenerationResults(assetId)
    ));
    const resultIds = lists.flatMap((items) => items[0] ? [items[0].id] : []);
    if (resultIds.length === 0) {
      setOperationNotice('所选照片还没有可导出的生成版本。');
      return;
    }
    setOperationNotice(await exportResults(resultIds));
  };

  const regenerate = async (result: GenerationResult): Promise<string> => {
    await window.desktopApi.enqueueTask({
      kind: 'generation',
      assetId: result.assetId,
      payload: {
        providerProfileId: result.providerProfileId,
        batchId: crypto.randomUUID(),
        prompt: result.prompt,
        templateId: result.templateId,
        templateVersion: result.templateVersion,
        resultIndex: 1
      }
    });
    setTasksOpen(true);
    return '已按当前方案加入 1 个生成任务。';
  };

  const addTags = async () => {
    const names = tagDraft.split(',').map((name) => name.trim()).filter(Boolean);
    if (names.length === 0) return;
    const assetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
    await window.desktopApi.updateCatalogTags({ assetIds, addTags: names, removeTagIds: [] });
    setTagDraft('');
    setTagEditorOpen(false);
    setOperationNotice(`已为 ${assetIds.length} 张照片添加标签。`);
    await onRefreshCatalog();
  };

  const openFolderDialog = (action: 'move' | 'copy') => {
    const firstTarget = catalogFolders.find((folder) => folder.id !== selected.folderId);
    setFolderAction(action);
    setMoveTargetFolderId(firstTarget?.id ?? catalogFolders[0]?.id ?? '');
    setMoveDialogOpen(true);
  };

  const executeFolderOperation = async () => {
    if (!moveTargetFolderId || moveBusy) return;
    const assetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
    setMoveBusy(true);
    try {
      const report = folderAction === 'move'
        ? await window.desktopApi.moveCatalogAssets({ assetIds, targetFolderId: moveTargetFolderId })
        : await window.desktopApi.copyCatalogAssets({ assetIds, targetFolderId: moveTargetFolderId });
      if (report.status === 'completed') {
        if ('moved' in report) {
          const renamed = report.files.filter((item) => item.fileName !== item.previousFileName).length;
          setOperationNotice(`已移动 ${report.moved} 张照片${report.skipped ? `，跳过 ${report.skipped} 张` : ''}${renamed ? `，${renamed} 张已自动避让重名` : ''}。`);
        } else {
          setOperationNotice(`已复制 ${report.copied} 张照片。`);
        }
        setMoveDialogOpen(false);
        await onRefreshCatalog();
      } else {
        setOperationNotice(report.rolledBack
          ? `${folderAction === 'move' ? '移动' : '复制'}失败，文件系统已恢复（${report.errorCode ?? '未知错误'}）。`
          : `${folderAction === 'move' ? '移动' : '复制'}失败且未能完整恢复，请记录操作号 ${report.operationId}。`);
      }
    } catch {
      setOperationNotice(`无法开始${folderAction === 'move' ? '移动' : '复制'}，请确认目标文件夹仍然可用。`);
    } finally {
      setMoveBusy(false);
    }
  };

  const openRenameDialog = () => {
    setRenameDraft(selected.fileName);
    setRenameDialogOpen(true);
  };

  const renameSelected = async () => {
    if (!renameDraft || renameBusy) return;
    setRenameBusy(true);
    try {
      const report = await window.desktopApi.renameCatalogAsset({ assetId: selected.id, fileName: renameDraft });
      if (report.status === 'completed') {
        setOperationNotice(`已重命名为 ${report.fileName}。`);
        setRenameDialogOpen(false);
        await onRefreshCatalog();
      } else {
        setOperationNotice(report.rolledBack
          ? `重命名失败，文件已恢复原名（${report.errorCode ?? '未知错误'}）。`
          : `重命名失败且未能恢复，请记录操作号 ${report.operationId}。`);
      }
    } catch {
      setOperationNotice('无法重命名：请保留原扩展名，并避免重名或系统保留名称。');
    } finally {
      setRenameBusy(false);
    }
  };

  const executeRemoval = async () => {
    if (!removalMode || removalBusy) return;
    const assetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
    setRemovalBusy(true);
    try {
      const report = removalMode === 'remove'
        ? await window.desktopApi.removeCatalogAssets({ assetIds })
        : await window.desktopApi.trashCatalogAssets({ assetIds });
      if (report.status === 'completed') {
        setOperationNotice(removalMode === 'remove'
          ? `已从图库移除 ${report.succeeded} 张照片，磁盘文件保持不变。`
          : `已将 ${report.succeeded} 张原图移到系统回收站。`);
      } else {
        setOperationNotice(`${removalMode === 'remove' ? '移除' : '回收'}完成 ${report.succeeded} 张，失败 ${report.failed} 张。`);
      }
      setRemovalMode(null);
      await onRefreshCatalog();
    } catch {
      setOperationNotice('操作未执行：请先取消所选照片的活动任务，并确认文件仍可访问。');
    } finally {
      setRemovalBusy(false);
    }
  };

  const updateAlbumMembership = async (mode: 'add' | 'remove') => {
    const albumId = mode === 'remove' ? selectedAlbumId : albumTargetId;
    if (!albumId) return;
    const assetIds = [...selection.selectedIds];
    try {
      const album = await window.desktopApi.updateCatalogAlbumAssets({ albumId, assetIds, mode });
      setOperationNotice(mode === 'add' ? `已将 ${assetIds.length} 张照片加入「${album.name}」。` : `已从「${album.name}」移出 ${assetIds.length} 张照片。`);
      await onRefreshCatalog();
    } catch {
      setOperationNotice('相册更新失败，请确认照片仍在图库中。');
    }
  };

  useEffect(() => {
    if (!moveDialogOpen && !renameDialogOpen && !removalMode) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !moveBusy) setMoveDialogOpen(false);
      if (event.key === 'Escape' && !renameBusy) setRenameDialogOpen(false);
      if (event.key === 'Escape' && !removalBusy) setRemovalMode(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [moveBusy, moveDialogOpen, removalBusy, removalMode, renameBusy, renameDialogOpen]);

  return (
    <div className="workspace">
      <Sidebar folders={catalogFolders} albums={catalogAlbums} smartCollections={catalogSmartCollections} totalCount={totalCount} selectedFolderId={selectedFolderId} selectedAlbumId={selectedAlbumId} selectedSmartCollection={selectedSmartCollection} tags={catalogTags} selectedTagId={selectedTagId} onSelectFolder={onSelectFolder} onSelectAlbum={onSelectAlbum} onSelectSmartCollection={onSelectSmartCollection} onRefreshAlbums={onRefreshAlbums} onSelectTag={onSelectTag} isDemo={isDemo} />
      <main className="library-main">
        <Filmstrip items={availablePhotos} selected={selected} selection={selection} onSelect={selectPhoto} collectionName={collectionName} totalCount={totalCount} hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} />
        <Viewer photo={selected} results={generationResults} isDemo={isDemo} onExport={exportResults} onRate={(rating) => void rateSelection(rating)} onRegenerate={regenerate} onEditTags={() => setTagEditorOpen(true)} onMove={() => openFolderDialog('move')} onCopy={() => openFolderDialog('copy')} onRename={openRenameDialog} onRemove={() => setRemovalMode('remove')} onTrash={() => setRemovalMode('trash')} />
      </main>
      <AiPanel revision={analysisRevision} isDemo={isDemo} notice={analysisNotice} onAnalyze={() => void analyzeSelection()} generationProfiles={generationProfiles} templates={templateItems} onGenerate={generateSelection} />
      {selection.selectedIds.size > 1 && (
        <div className="batch-actionbar">
          <strong>已选择 {selection.selectedIds.size} 张</strong>
          <span />
          <button type="button" onClick={() => void rateSelection(5)}><Star size={14} />5 星</button>
          <button type="button" onClick={() => setTagEditorOpen(true)}><Tags size={14} />标签</button>
          {!isDemo && <><button type="button" onClick={() => openFolderDialog('copy')}><Copy size={14} />复制</button><button type="button" onClick={() => openFolderDialog('move')}><FolderInput size={14} />移动</button></>}
          <button type="button" onClick={() => void analyzeSelection()}><Sparkles size={14} />AI 分析</button>
          <button type="button" onClick={() => void generateSelection({ providerProfileId: generationProfiles[0]?.id ?? '', template: null, count: 1, instruction: '', disabledActionIds: new Set() })} disabled={generationProfiles.length === 0}><WandSparkles size={14} />批量生成</button>
          <button type="button" onClick={() => void exportLatestSelection()}><Download size={14} />导出</button>
          {!isDemo && catalogAlbums.length > 0 && <><select aria-label="目标相册" value={albumTargetId} onChange={(event) => setAlbumTargetId(event.target.value)}><option value="">相册</option>{catalogAlbums.map((album) => <option key={album.id} value={album.id}>{album.name}</option>)}</select><button type="button" disabled={!albumTargetId} onClick={() => void updateAlbumMembership('add')}><FolderHeart size={14} />加入</button>{selectedAlbumId && <button type="button" onClick={() => void updateAlbumMembership('remove')}><FolderHeart size={14} />移出</button>}</>}
          {!isDemo && <><button type="button" onClick={() => setRemovalMode('remove')}><LibraryBig size={14} />移除</button><button className="is-danger" type="button" onClick={() => setRemovalMode('trash')}><Trash2 size={14} />回收站</button></>}
          <IconButton label="清除选择" onClick={() => setSelection({ selectedIds: new Set(), anchorId: null, focusId: selected.id })}><X size={14} /></IconButton>
        </div>
      )}
      {tagEditorOpen && <form className="tag-editor-popover" onSubmit={(event) => { event.preventDefault(); void addTags(); }}><label><span>添加标签</span><input autoFocus value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="人像, 夜景" /></label><button className="primary-action compact" type="submit">应用</button><IconButton label="关闭标签编辑器" onClick={() => setTagEditorOpen(false)}><X size={13} /></IconButton></form>}
      {moveDialogOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !moveBusy) setMoveDialogOpen(false); }}>
          <section className="move-dialog" role="dialog" aria-modal="true" aria-labelledby="move-dialog-title">
            <header><div><span className="dialog-icon">{folderAction === 'move' ? <FolderInput size={16} /> : <Copy size={16} />}</span><div><h2 id="move-dialog-title">{folderAction === 'move' ? '移动' : '复制'} {selection.selectedIds.size || 1} 张照片</h2><p>{folderAction === 'move' ? '原图将移动到已导入的目标文件夹，AI 版本保持不变。' : '将创建独立原图副本，并继承评分、收藏和用户标签。'}</p></div></div><IconButton label={`关闭${folderAction === 'move' ? '移动' : '复制'}窗口`} disabled={moveBusy} onClick={() => setMoveDialogOpen(false)}><X size={15} /></IconButton></header>
            <div className="move-folder-list" role="radiogroup" aria-label="目标文件夹">
              {catalogFolders.map((folder) => (
                <label className={moveTargetFolderId === folder.id ? 'is-selected' : ''} key={folder.id}>
                  <input type="radio" name="move-target" value={folder.id} checked={moveTargetFolderId === folder.id} autoFocus={moveTargetFolderId === folder.id} onChange={() => setMoveTargetFolderId(folder.id)} />
                  <Folder size={16} /><span><strong>{folder.name}</strong><small>{folder.assetCount} 张照片</small></span><Check size={15} />
                </label>
              ))}
            </div>
            <footer><span>重名文件会自动增加编号，不会覆盖已有文件。</span><div><button className="quiet-button" type="button" disabled={moveBusy} onClick={() => setMoveDialogOpen(false)}>取消</button><button className="primary-action compact" type="button" disabled={!moveTargetFolderId || moveBusy} onClick={() => void executeFolderOperation()}>{moveBusy ? `正在${folderAction === 'move' ? '移动' : '复制'}…` : folderAction === 'move' ? '移动' : '复制'}</button></div></footer>
          </section>
        </div>
      )}
      {renameDialogOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !renameBusy) setRenameDialogOpen(false); }}>
          <form className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-dialog-title" onSubmit={(event) => { event.preventDefault(); void renameSelected(); }}>
            <header><div><span className="dialog-icon"><FilePenLine size={16} /></span><div><h2 id="rename-dialog-title">重命名照片</h2><p>Asset 身份、分析记录和生成版本不会改变。</p></div></div><IconButton label="关闭重命名窗口" disabled={renameBusy} onClick={() => setRenameDialogOpen(false)}><X size={15} /></IconButton></header>
            <label className="rename-field"><span>文件名</span><input autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} aria-label="新文件名" spellCheck={false} /></label>
            <footer><span>必须保留原扩展名，且不会覆盖同名文件。</span><div><button className="quiet-button" type="button" disabled={renameBusy} onClick={() => setRenameDialogOpen(false)}>取消</button><button className="primary-action compact" type="submit" disabled={!renameDraft || renameDraft === selected.fileName || renameBusy}>{renameBusy ? '正在重命名…' : '重命名'}</button></div></footer>
          </form>
        </div>
      )}
      {removalMode && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !removalBusy) setRemovalMode(null); }}>
          <section className={`removal-dialog${removalMode === 'trash' ? ' is-destructive' : ''}`} role="alertdialog" aria-modal="true" aria-labelledby="removal-dialog-title">
            <header><span className="dialog-icon">{removalMode === 'remove' ? <LibraryBig size={17} /> : <Trash2 size={17} />}</span><div><h2 id="removal-dialog-title">{removalMode === 'remove' ? '从图库移除' : '移到系统回收站'} {selection.selectedIds.size || 1} 张照片？</h2><p>{removalMode === 'remove' ? '磁盘原文件不会改变。重新扫描同一路径可恢复评分、标签、分析和 AI 版本。' : '原文件将进入操作系统回收站，应用会保留关联记录；恢复原文件后可重新导入。'}</p></div></header>
            <div className="removal-impact"><CircleAlert size={15} /><span>{removalMode === 'remove' ? '照片会立即从当前图库、文件夹计数和搜索结果中隐藏。' : '此操作可能由系统要求额外权限，批量处理会逐项报告失败。'}</span></div>
            <footer><button className="quiet-button" type="button" disabled={removalBusy} onClick={() => setRemovalMode(null)}>取消</button><button className={removalMode === 'trash' ? 'danger-action' : 'primary-action compact'} type="button" disabled={removalBusy} onClick={() => void executeRemoval()}>{removalBusy ? '正在处理…' : removalMode === 'remove' ? '仅从图库移除' : '移到回收站'}</button></footer>
          </section>
        </div>
      )}
      {operationNotice && <div className="operation-toast" role="status">{operationNotice}<button type="button" aria-label="关闭提示" onClick={() => setOperationNotice('')}><X size={13} /></button></div>}
      <TaskBar open={tasksOpen} onToggle={() => setTasksOpen((value) => !value)} tasks={isDemo ? null : taskItems} />
    </div>
  );
}

const emptyProviderForm: SaveProviderProfileInput = {
  name: '',
  kind: 'openai-compatible',
  purpose: 'vision',
  baseUrl: '',
  modelId: '',
  apiKey: '',
  enabled: true
};

function SettingsPage(): React.JSX.Element {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [form, setForm] = useState<SaveProviderProfileInput>(emptyProviderForm);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);

  useEffect(() => {
    void window.desktopApi.listProviderProfiles().then(setProfiles);
  }, []);

  const patchForm = <Key extends keyof SaveProviderProfileInput>(key: Key, value: SaveProviderProfileInput[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setMessage('');
  };

  const save = async () => {
    setBusy('save');
    try {
      const saved = await window.desktopApi.saveProviderProfile(form);
      setProfiles((current) => [...current.filter((profile) => profile.id !== saved.id), saved]);
      setForm(emptyProviderForm);
      setMessage('配置已安全保存');
    } catch {
      setMessage('保存失败，请检查必填项和服务地址');
    } finally {
      setBusy(null);
    }
  };

  const testConnection = async () => {
    setBusy('test');
    try {
      const result = await window.desktopApi.testProviderConnection(form);
      setMessage(`${result.message}${result.latencyMs > 0 ? ` · ${result.latencyMs} ms` : ''}`);
    } catch {
      setMessage('连接测试失败，请检查配置');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-page">
      <aside className="settings-nav">
        <strong>设置</strong>
        <button className="is-active" type="button"><Bot size={14} />AI 模型</button>
        <button type="button"><Folder size={14} />图库与存储</button>
        <button type="button"><Clock3 size={14} />任务与重试</button>
        <button type="button"><Command size={14} />快捷键</button>
        <button type="button"><ShieldCheck size={14} />隐私与安全</button>
      </aside>
      <main className="settings-content">
        <div className="settings-heading">
          <div><h1>AI 模型</h1><p>配置用于视觉分析与图片生成的兼容服务。应用不会提供默认密钥。</p></div>
          <span><ShieldCheck size={14} />凭据由系统安全存储保护</span>
        </div>

        <section className="provider-layout">
          <div className="provider-list">
            <div className="provider-list-head"><strong>已配置服务</strong><span>{profiles.length}</span></div>
            {profiles.length === 0 ? (
              <div className="provider-empty"><Server size={25} /><strong>尚未配置模型</strong><span>填写右侧表单开始使用 AI 功能</span></div>
            ) : profiles.map((profile) => (
              <button className="provider-item" key={profile.id} type="button" onClick={() => setForm({
                id: profile.id,
                name: profile.name,
                kind: profile.kind,
                purpose: profile.purpose,
                baseUrl: profile.baseUrl,
                modelId: profile.modelId,
                enabled: profile.enabled
              })}>
                <span className="provider-icon">{profile.purpose === 'vision' ? <Bot size={16} /> : <WandSparkles size={16} />}</span>
                <span><strong>{profile.name}</strong><small>{profile.modelId}</small></span>
                <i className={profile.enabled ? 'is-online' : ''} />
              </button>
            ))}
          </div>

          <form className="provider-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <div className="form-title"><span className="provider-icon"><Plus size={16} /></span><div><strong>{form.id ? '编辑模型配置' : '添加模型配置'}</strong><small>所有字段均保存在本机</small></div></div>
            <div className="form-grid two-columns">
              <label><span>用途</span><select value={form.purpose} onChange={(event) => patchForm('purpose', event.target.value as SaveProviderProfileInput['purpose'])}><option value="vision">视觉分析模型</option><option value="generation">图片生成模型</option></select></label>
              <label><span>接口类型</span><select value={form.kind} onChange={(event) => patchForm('kind', event.target.value as SaveProviderProfileInput['kind'])}><option value="openai-compatible">OpenAI Compatible</option><option value="nanobanana-compatible">NanoBanana Compatible</option></select></label>
            </div>
            <label><span>配置名称</span><input required maxLength={80} placeholder="例如：视觉分析 · 主服务" value={form.name} onChange={(event) => patchForm('name', event.target.value)} /></label>
            <label><span>Base URL</span><input required type="url" placeholder="https://api.example.com/v1" value={form.baseUrl} onChange={(event) => patchForm('baseUrl', event.target.value)} /><small>远程地址必须使用 HTTPS；本地开发服务可使用 localhost HTTP。</small></label>
            <label><span>Model ID</span><input required placeholder="模型标识" value={form.modelId} onChange={(event) => patchForm('modelId', event.target.value)} /></label>
            <label><span>API Key</span><div className="secret-input"><KeyRound size={14} /><input type="password" autoComplete="off" placeholder={form.id ? '留空以保留已保存凭据' : '输入服务密钥'} value={form.apiKey ?? ''} onChange={(event) => patchForm('apiKey', event.target.value)} /></div><small>密钥不会写入图库数据库、日志或导出清单。</small></label>
            <label className="enabled-row"><input type="checkbox" checked={form.enabled} onChange={(event) => patchForm('enabled', event.target.checked)} /><span>启用此配置</span></label>
            <div className="form-feedback" role="status">{message}</div>
            <div className="form-actions"><button className="secondary-action" type="button" disabled={busy !== null} onClick={() => void testConnection()}>{busy === 'test' ? '测试中…' : '测试连接'}</button><button className="primary-action compact" type="submit" disabled={busy !== null}>{busy === 'save' ? '保存中…' : '保存配置'}</button></div>
          </form>
        </section>
      </main>
    </div>
  );
}

const taskLabels: Record<PersistedTask['kind'], string> = {
  analysis: '视觉分析',
  generation: '图片生成',
  export: '导出'
};

const statusLabels: Record<PersistedTask['status'], string> = {
  draft: '草稿', queued: '等待中', preparing: '准备输入', uploading: '上传中',
  processing: '处理中', downloading: '下载中', saving: '保存中', completed: '已完成',
  failed: '失败', canceled: '已取消'
};

const fileOperationLabels: Record<FileOperationHistoryItem['kind'], string> = {
  move: '移动原图', copy: '复制原图', rename: '重命名', remove: '从图库移除', trash: '移到系统回收站'
};

const fileOperationStatusLabels: Record<FileOperationHistoryItem['status'], string> = {
  planned: '已计划', executing: '执行中', compensating: '恢复中', completed: '已完成',
  partial: '部分完成', failed: '失败', compensation_failed: '需处理'
};

function TaskCenterPage(): React.JSX.Element {
  const [taskItems, setTaskItems] = useState<PersistedTask[]>([]);
  const [fileOperations, setFileOperations] = useState<FileOperationHistoryItem[]>([]);
  const [message, setMessage] = useState('');

  const refresh = () => window.desktopApi.listTasks().then(setTaskItems);
  useEffect(() => {
    let active = true;
    const poll = () => {
      void Promise.all([window.desktopApi.listTasks(), window.desktopApi.listFileOperationHistory()])
        .then(([items, operations]) => {
          if (active) {
            setTaskItems(items);
            setFileOperations(operations);
          }
        });
    };
    poll();
    const interval = window.setInterval(poll, 1_000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  const cancel = async (taskId: string) => {
    await window.desktopApi.cancelTask(taskId);
    await refresh();
  };
  const retry = async (taskId: string) => {
    await window.desktopApi.retryTask(taskId);
    await refresh();
  };
  const moveQueued = async (taskId: string, direction: -1 | 1) => {
    const queuedIds = taskItems.filter((task) => task.status === 'queued').map((task) => task.id);
    const index = queuedIds.indexOf(taskId);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= queuedIds.length) return;
    [queuedIds[index], queuedIds[destination]] = [queuedIds[destination]!, queuedIds[index]!];
    setTaskItems(await window.desktopApi.reorderTasks(queuedIds));
  };
  const retryFailedGeneration = async () => {
    const failedIds = taskItems
      .filter((task) => task.kind === 'generation' && task.status === 'failed')
      .map((task) => task.id);
    for (const taskId of failedIds) await window.desktopApi.retryTask(taskId);
    setMessage(`已重新排队 ${failedIds.length} 个生成任务。`);
    await refresh();
  };

  const waiting = taskItems.filter((task) => task.status === 'queued').length;
  const failed = taskItems.filter((task) => task.status === 'failed').length;
  const failedGeneration = taskItems.filter((task) => task.kind === 'generation' && task.status === 'failed').length;
  const queuedIds = taskItems.filter((task) => task.status === 'queued').map((task) => task.id);

  return (
    <div className="task-center-page">
      <div className="task-center-heading">
        <div><h1>任务中心</h1><p>生成任务默认串行执行，等待任务可以调整或取消。</p></div>
        <div className="task-heading-actions">
          {message && <span className="task-feedback" role="status">{message}</span>}
          <button className="secondary-action" type="button" disabled={failedGeneration === 0} onClick={() => void retryFailedGeneration()}><RotateCcw size={13} />重试失败生成 ({failedGeneration})</button>
          <div className="task-summary"><span><i className="task-dot queued" />等待 {waiting}</span><span><i className="task-dot failed" />失败 {failed}</span></div>
        </div>
      </div>
      <div className="task-table">
        <div className="task-table-head"><span>任务</span><span>状态</span><span>进度</span><span>尝试</span><span>更新时间</span><span /></div>
        {taskItems.length === 0 ? (
          <div className="task-empty"><Clock3 size={30} /><h2>暂无任务</h2><p>从图库选择照片并执行 AI 分析或生成后，任务会出现在这里。</p></div>
        ) : taskItems.map((task) => (
          <div className="task-table-row" key={task.id}>
            <span className="task-kind"><i><TaskKindIcon kind={task.kind} /></i><span><strong>{taskLabels[task.kind]}</strong><small>{task.assetId ?? '批量任务'}</small></span></span>
            <span className={`task-state state-${task.status}`}>{statusLabels[task.status]}</span>
            <span className="table-progress"><i style={{ width: `${Math.round(task.progress * 100)}%` }} /><em>{Math.round(task.progress * 100)}%</em></span>
            <span>{task.attempt + 1}</span>
            <span>{new Date(task.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <span className="task-row-actions">
              {task.status === 'queued' && <><IconButton label="任务上移" disabled={queuedIds.indexOf(task.id) === 0} onClick={() => void moveQueued(task.id, -1)}><ArrowUp size={13} /></IconButton><IconButton label="任务下移" disabled={queuedIds.indexOf(task.id) === queuedIds.length - 1} onClick={() => void moveQueued(task.id, 1)}><ArrowDown size={13} /></IconButton></>}
              {(task.status === 'queued' || task.status === 'preparing' || task.status === 'uploading' || task.status === 'processing' || task.status === 'downloading') && <button type="button" onClick={() => void cancel(task.id)}>取消</button>}
              {(task.status === 'failed' || task.status === 'canceled') && <button type="button" onClick={() => void retry(task.id)}>重试</button>}
            </span>
          </div>
        ))}
      </div>
      <section className="operation-history">
        <header><div><History size={15} /><span><strong>文件操作</strong><small>最近 {fileOperations.length} 条</small></span></div></header>
        {fileOperations.length === 0 ? <div className="operation-history-empty">暂无文件操作</div> : (
          <div className="operation-history-list">
            {fileOperations.map((operation) => (
              <div className="operation-history-row" key={operation.id}>
                <span><strong>{fileOperationLabels[operation.kind]}</strong><small>{operation.fileNames.join('、')}{operation.total > operation.fileNames.length ? ` 等 ${operation.total} 项` : ''}</small></span>
                <span className={`operation-state state-${operation.status}`}>{fileOperationStatusLabels[operation.status]}</span>
                <span>{operation.succeeded}/{operation.total}</span>
                <time>{new Date(operation.createdAt).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function TaskKindIcon({ kind }: { kind: PersistedTask['kind'] }): React.JSX.Element {
  if (kind === 'analysis') return <Bot size={15} />;
  if (kind === 'generation') return <WandSparkles size={15} />;
  return <Download size={15} />;
}

const emptyTemplateForm: SavePromptTemplateInput = {
  name: '',
  description: '',
  category: '人像',
  body: '{{analysis.summary}}\n\n需要执行：\n{{analysis.generative_actions}}\n\n用户补充：\n{{user_instruction}}\n\n必须保留：\n{{preservation_rules}}'
};

function TemplatePage(): React.JSX.Element {
  const [templateItems, setTemplateItems] = useState<PromptTemplate[]>([]);
  const [form, setForm] = useState<SavePromptTemplateInput>(emptyTemplateForm);
  const [message, setMessage] = useState('');

  useEffect(() => { void window.desktopApi.listPromptTemplates().then(setTemplateItems); }, []);

  const patchTemplate = <Key extends keyof SavePromptTemplateInput>(key: Key, value: SavePromptTemplateInput[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setMessage('');
  };

  const save = async () => {
    try {
      const saved = await window.desktopApi.savePromptTemplate(form);
      setTemplateItems((current) => [saved, ...current.filter((template) => template.id !== saved.id)]);
      setForm({ ...saved });
      setMessage(`已保存版本 ${saved.version}`);
    } catch {
      setMessage('保存失败，请检查模板名称和正文');
    }
  };

  return (
    <div className="template-page">
      <div className="template-page-heading">
        <div><h1>提示词模板</h1><p>模板与 AI 分析动作组合，入队时保存具体版本快照。</p></div>
        <button className="primary-action compact" type="button" onClick={() => { setForm(emptyTemplateForm); setMessage(''); }}><Plus size={15} />新建模板</button>
      </div>
      <div className="template-workspace">
        <section className="template-browser">
          <div className="template-browser-tools"><div className="inline-search"><Search size={14} /><input placeholder="搜索模板" /></div><button type="button"><ListFilter size={14} />全部分类</button></div>
          {templateItems.length === 0 ? (
            <div className="template-empty"><WandSparkles size={30} /><h2>尚未创建模板</h2><p>创建第一个模板，把常用修图要求和保护规则保存下来。</p></div>
          ) : (
            <div className="template-grid">
              {templateItems.map((template, index) => (
                <button className={`template-card${form.id === template.id ? ' is-selected' : ''}`} key={template.id} type="button" onClick={() => setForm({
                  id: template.id,
                  name: template.name,
                  description: template.description,
                  category: template.category,
                  body: template.body
                })}>
                  <span className="template-card-image"><img src={`./demo/${['portrait', 'street', 'coast'][index % 3]}.jpg`} alt="" /><i>{template.category}</i></span>
                  <span className="template-card-copy"><strong>{template.name}</strong><small>{template.description || '暂无描述'}</small><em>版本 {template.version}</em></span>
                </button>
              ))}
            </div>
          )}
        </section>
        <form className="template-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <div className="template-editor-head"><div><strong>{form.id ? '编辑模板' : '创建模板'}</strong><small>保存修改会创建新版本</small></div>{form.id && <span>不可变版本</span>}</div>
          <label><span>模板名称</span><input required maxLength={120} value={form.name} placeholder="例如：自然人像 · 清洁背景" onChange={(event) => patchTemplate('name', event.target.value)} /></label>
          <div className="form-grid two-columns"><label><span>分类</span><select value={form.category} onChange={(event) => patchTemplate('category', event.target.value)}><option>人像</option><option>风光</option><option>商品</option><option>建筑</option><option>其他</option></select></label><label><span>简短描述</span><input maxLength={2_000} value={form.description} placeholder="说明适用场景和效果" onChange={(event) => patchTemplate('description', event.target.value)} /></label></div>
          <label className="template-body-field"><span>模板正文</span><textarea required value={form.body} onChange={(event) => patchTemplate('body', event.target.value)} /></label>
          <div className="template-variables"><span>可用变量</span>{['analysis.summary', 'analysis.generative_actions', 'catalog.subjects', 'user_instruction', 'preservation_rules'].map((variable) => <code key={variable}>{`{{${variable}}}`}</code>)}</div>
          <div className="template-editor-footer"><span role="status">{message}</span><button className="primary-action compact" type="submit">{form.id ? '保存新版本' : '创建模板'}</button></div>
        </form>
      </div>
    </div>
  );
}

export function App(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('library');
  const [openTabs, setOpenTabs] = useState<WorkspaceTab[]>(['library', 'templates', 'tasks', 'settings']);
  const [sessionReady, setSessionReady] = useState(false);
  const [catalogPhotos, setCatalogPhotos] = useState<Photo[]>([]);
  const [catalogFolders, setCatalogFolders] = useState<CatalogFolder[]>([]);
  const [catalogAlbums, setCatalogAlbums] = useState<CatalogAlbum[]>([]);
  const [catalogSmartCollections, setCatalogSmartCollections] = useState<CatalogSmartCollection[]>([]);
  const [catalogTags, setCatalogTags] = useState<CatalogTag[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [selectedSmartCollection, setSelectedSmartCollection] = useState<CatalogSmartCollection['id'] | null>(null);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<CatalogAssetCursor | null>(null);
  const [catalogReady, setCatalogReady] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchDraft, setSearchDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const catalogRequest = useRef(0);

  useEffect(() => {
    let active = true;
    void window.desktopApi.getWorkspaceSession().then((session) => {
      if (!active) return;
      setOpenTabs(session.openTabs);
      setActiveTab(session.activeTab);
      setSelectedFolderId(session.library.selectedFolderId);
      setSelectedTagId(session.library.selectedTagId);
      setSelectedAssetId(session.library.selectedAssetId);
      setSearchDraft(session.library.searchQuery);
      setSearchQuery(session.library.searchQuery);
      setSessionReady(true);
    }).catch(() => setSessionReady(true));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!sessionReady) return;
    const session: WorkspaceSession = {
      version: 1,
      openTabs,
      activeTab,
      library: { selectedFolderId, selectedTagId, selectedAssetId, searchQuery: searchDraft.trim() }
    };
    const timeout = window.setTimeout(() => {
      void window.desktopApi.saveWorkspaceSession(session).catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timeout);
  }, [activeTab, openTabs, searchDraft, selectedAssetId, selectedFolderId, selectedTagId, sessionReady]);

  const refreshCatalog = useCallback(async () => {
    const request = ++catalogRequest.current;
    setLoadingMore(true);
    try {
      const [page, folders, tags, albums, smartCollections] = await Promise.all([
        window.desktopApi.listCatalogAssetPage({ folderId: selectedFolderId, tagId: selectedTagId, albumId: selectedAlbumId, smartCollection: selectedSmartCollection, query: searchQuery, cursor: null, limit: 200 }),
        window.desktopApi.listCatalogFolders(),
        window.desktopApi.listCatalogTags(),
        window.desktopApi.listCatalogAlbums(),
        window.desktopApi.listCatalogSmartCollections()
      ]);
      if (request !== catalogRequest.current) return;
      setCatalogPhotos(mapCatalogAssets(page.items));
      setCatalogFolders(folders);
      setCatalogTags(tags);
      setCatalogAlbums(albums);
      setCatalogSmartCollections(smartCollections);
      if (selectedFolderId && !folders.some((folder) => folder.id === selectedFolderId)) setSelectedFolderId(null);
      if (selectedTagId && !tags.some((tag) => tag.id === selectedTagId)) setSelectedTagId(null);
      if (selectedAlbumId && !albums.some((album) => album.id === selectedAlbumId)) setSelectedAlbumId(null);
      setCatalogTotal(page.totalCount);
      setNextCursor(page.nextCursor);
      setCatalogReady(true);
    } finally {
      if (request === catalogRequest.current) setLoadingMore(false);
    }
  }, [searchQuery, selectedAlbumId, selectedFolderId, selectedSmartCollection, selectedTagId]);

  useEffect(() => {
    if (!sessionReady) return;
    void refreshCatalog();
  }, [refreshCatalog, sessionReady]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setSearchQuery(searchDraft.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [searchDraft]);

  const importFolders = async () => {
    const result = await window.desktopApi.importFolders();
    if (result) await refreshCatalog();
  };

  const openWorkspaceTab = useCallback((tab: WorkspaceTab) => {
    setOpenTabs((current) => current.includes(tab) ? current : [...current, tab]);
    setActiveTab(tab);
  }, []);

  const closeWorkspaceTab = useCallback((tab: WorkspaceTab) => {
    if (tab === 'library') return;
    setOpenTabs((current) => current.filter((item) => item !== tab));
    setActiveTab((current) => current === tab ? 'library' : current);
  }, []);

  useEffect(() => {
    const handleWorkspaceShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === 'w' && activeTab !== 'library') {
        event.preventDefault();
        closeWorkspaceTab(activeTab);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const currentIndex = openTabs.indexOf(activeTab);
        const direction = event.shiftKey ? -1 : 1;
        const nextIndex = (currentIndex + direction + openTabs.length) % openTabs.length;
        setActiveTab(openTabs[nextIndex]!);
      }
    };
    window.addEventListener('keydown', handleWorkspaceShortcut);
    return () => window.removeEventListener('keydown', handleWorkspaceShortcut);
  }, [activeTab, closeWorkspaceTab, openTabs]);

  const loadMoreCatalog = async () => {
    if (!nextCursor || loadingMore) return;
    const request = ++catalogRequest.current;
    setLoadingMore(true);
    try {
      const page = await window.desktopApi.listCatalogAssetPage({
        folderId: selectedFolderId,
        tagId: selectedTagId,
        albumId: selectedAlbumId,
        smartCollection: selectedSmartCollection,
        query: searchQuery,
        cursor: nextCursor,
        limit: 200
      });
      if (request !== catalogRequest.current) return;
      setCatalogPhotos((current) => {
        const known = new Set(current.map((photo) => photo.id));
        return [...current, ...mapCatalogAssets(page.items).filter((photo) => !known.has(photo.id))];
      });
      setCatalogTotal(page.totalCount);
      setNextCursor(page.nextCursor);
    } finally {
      if (request === catalogRequest.current) setLoadingMore(false);
    }
  };

  const isDemo = catalogReady && catalogTotal === 0 && catalogFolders.length === 0;
  const availablePhotos = !catalogReady || isDemo ? photos : catalogPhotos;
  const displayTotal = isDemo || !catalogReady ? 128 : catalogTotal;

  return (
    <div className="app-shell">
      <AppHeader active={activeTab} openTabs={openTabs} onChange={setActiveTab} onClose={closeWorkspaceTab} onOpen={openWorkspaceTab} onImport={() => void importFolders()} search={searchDraft} onSearchChange={setSearchDraft} />
      {!sessionReady ? <main className="workspace-loading"><span className="working-pulse" /><span>正在恢复工作区</span></main> : activeTab === 'library' ? <LibraryWorkspace availablePhotos={availablePhotos} catalogFolders={catalogFolders} catalogAlbums={catalogAlbums} catalogSmartCollections={catalogSmartCollections} catalogTags={catalogTags} isDemo={isDemo || !catalogReady} selectedFolderId={selectedFolderId} selectedAlbumId={selectedAlbumId} selectedSmartCollection={selectedSmartCollection} selectedTagId={selectedTagId} selectedAssetId={selectedAssetId} onSelectedAssetChange={setSelectedAssetId} totalCount={displayTotal} hasMore={nextCursor !== null} loadingMore={loadingMore} onSelectFolder={(id) => { setSelectedFolderId(id); setSelectedAlbumId(null); setSelectedSmartCollection(null); }} onSelectAlbum={(id) => { setSelectedAlbumId(id); setSelectedFolderId(null); setSelectedSmartCollection(null); }} onSelectSmartCollection={(id) => { setSelectedSmartCollection(id); setSelectedFolderId(null); setSelectedAlbumId(null); }} onSelectTag={setSelectedTagId} onLoadMore={() => void loadMoreCatalog()} searchQuery={searchQuery} onRefreshCatalog={refreshCatalog} onRefreshAlbums={refreshCatalog} /> : activeTab === 'settings' ? <SettingsPage /> : activeTab === 'tasks' ? <TaskCenterPage /> : <TemplatePage />}
    </div>
  );
}
