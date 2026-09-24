import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  CatalogAsset,
  CatalogAlbum,
  CatalogSmartCollection,
  CatalogAssetCursor,
  CatalogFolder,
  CatalogCompanionPreview,
  CatalogTag,
  AnalysisResult,
  AnalysisRevision,
  GenerationResult,
  TrashedGenerationResult,
  FileOperationHistoryItem,
  PersistedTask,
  TaskListCursor,
  PromptTemplate,
  ProviderProfile,
  ExportPreset,
  ExportReport,
  ImageCacheStats,
  GenerationTrashSummary,
  DiagnosticSnapshot,
  SavePromptTemplateInput,
  SaveProviderProfileInput,
  WorkspaceSession,
  WorkspaceTab,
  AppSettings
} from '@photoallisai/contracts';
import { computeHorizontalWindow, composeGenerationPrompt, pickExportResults, selectAll, updateSelection, type ExportSelectionMode, type SelectionIntent, type SelectionState } from '@photoallisai/domain';
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
  FolderMinus,
  FolderOpen,
  GalleryHorizontalEnd,
  Grid2X2,
  Heart,
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
  SunMoon,
  ShieldCheck,
  Tags,
  Trash2,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react';

import { photos, type Photo } from './mock-data';
import { fileOperationFailureMessage } from './error-messages';

const THEME_CHANGE_EVENT = 'photoallisai-theme-change';
const E2E_DEMO_MODE = new URLSearchParams(window.location.search).get('e2e-demo') === '1';
const DEFAULT_GENERATION_TEMPLATE_BODY = [
  '请基于原图进行专业且写实的修图。',
  '画面分析：{{analysis.summary}}',
  '编辑动作：\n{{analysis.generative_actions}}',
  '补充要求：{{user_instruction}}',
  '必须保留：\n{{preservation_rules}}'
].join('\n');

const FOLDER_APPEARANCE_KEY = 'photoallisai.folder-appearance.v1';
const FOLDER_COLORS = ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
type FolderColor = typeof FOLDER_COLORS[number];
type FolderAppearance = { sectionCollapsed: boolean; expandedIds: string[]; colors: Record<string, FolderColor> };

function loadFolderAppearance(): FolderAppearance {
  try {
    const saved = JSON.parse(window.localStorage.getItem(FOLDER_APPEARANCE_KEY) ?? '') as Partial<FolderAppearance>;
    const legacy = saved as Partial<FolderAppearance> & { collapsed?: boolean };
    return { sectionCollapsed: Boolean(legacy.sectionCollapsed ?? legacy.collapsed), expandedIds: legacy.expandedIds ?? [], colors: legacy.colors ?? {} };
  } catch {
    return { sectionCollapsed: false, expandedIds: [], colors: {} };
  }
}

function applyTheme(theme: AppSettings['theme']): void {
  const resolved = theme === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    : theme;
  document.documentElement.dataset.theme = resolved;
}

function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

type ViewerLayout = { leftWidth: number; rightWidth: number; filmstripHeight: number };
const VIEWER_LAYOUT_KEY = 'photoallisai.viewer-layout.v1';
const DEFAULT_VIEWER_LAYOUT: ViewerLayout = { leftWidth: 224, rightWidth: 300, filmstripHeight: 160 };

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function loadViewerLayout(): ViewerLayout {
  try {
    const saved = JSON.parse(window.localStorage.getItem(VIEWER_LAYOUT_KEY) ?? '') as Partial<ViewerLayout>;
    return {
      leftWidth: clamp(Number(saved.leftWidth) || DEFAULT_VIEWER_LAYOUT.leftWidth, 160, 420),
      rightWidth: clamp(Number(saved.rightWidth) || DEFAULT_VIEWER_LAYOUT.rightWidth, 240, 520),
      filmstripHeight: clamp(Number(saved.filmstripHeight) || DEFAULT_VIEWER_LAYOUT.filmstripHeight, 110, 320)
    };
  } catch {
    return DEFAULT_VIEWER_LAYOUT;
  }
}

function useViewerLayout(): [ViewerLayout, (key: keyof ViewerLayout, value: number) => void] {
  const [layout, setLayout] = useState<ViewerLayout>(loadViewerLayout);
  const update = useCallback((key: keyof ViewerLayout, value: number) => {
    const limits = key === 'leftWidth' ? [160, 420] : key === 'rightWidth' ? [240, 520] : [110, 320];
    setLayout((current) => ({ ...current, [key]: clamp(Math.round(value), limits[0]!, limits[1]!) }));
  }, []);
  useEffect(() => {
    window.localStorage.setItem(VIEWER_LAYOUT_KEY, JSON.stringify(layout));
  }, [layout]);
  return [layout, update];
}

function PaneSplitter({ orientation, value, minimum, maximum, label, onChange, invert = false }: {
  orientation: 'vertical' | 'horizontal';
  value: number;
  minimum: number;
  maximum: number;
  label: string;
  onChange: (value: number) => void;
  invert?: boolean;
}): React.JSX.Element {
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const origin = orientation === 'vertical' ? event.clientX : event.clientY;
    const initial = value;
    document.documentElement.classList.add(orientation === 'vertical' ? 'is-resizing-columns' : 'is-resizing-rows');
    const move = (moveEvent: PointerEvent) => {
      const position = orientation === 'vertical' ? moveEvent.clientX : moveEvent.clientY;
      const delta = (position - origin) * (invert ? -1 : 1);
      onChange(initial + delta);
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.documentElement.classList.remove('is-resizing-columns', 'is-resizing-rows');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  };
  return <div className={`pane-splitter is-${orientation}`} role="separator" tabIndex={0} aria-label={label} aria-orientation={orientation} aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={value} onPointerDown={startDrag} onKeyDown={(event) => {
    const previous = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const next = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== previous && event.key !== next) return;
    event.preventDefault();
    const direction = event.key === next ? 1 : -1;
    onChange(value + direction * (invert ? -12 : 12));
  }}><span /></div>;
}

function BufferedPreviewImage({ src, alt, className, onReady }: { src: string; alt: string; className: string; onReady?: (image: HTMLImageElement) => void }): React.JSX.Element {
  const [displayed, setDisplayed] = useState({ src, alt });
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!src || src === displayed.src || src === failedSrc) return;
    let active = true;
    setLoading(true);
    const image = new window.Image();
    image.onload = async () => {
      try {
        await image.decode();
      } catch {
        // onload already proved the image is usable; decode can reject for cached images.
      }
      if (!active) return;
      setDisplayed({ src, alt });
      setFailedSrc(null);
      setLoading(false);
      onReady?.(image);
    };
    image.onerror = () => {
      if (!active) return;
      setDisplayed({ src: '', alt });
      setFailedSrc(src);
      setLoading(false);
    };
    image.src = src;
    return () => { active = false; };
  }, [alt, displayed.src, failedSrc, onReady, src]);
  return <>{displayed.src ? <img className={className} src={displayed.src} alt={displayed.alt} onLoad={(event) => onReady?.(event.currentTarget)} /> : null}{loading && <span className="preview-loading" aria-label="正在载入下一张照片"><span className="working-pulse" /></span>}</>;
}

type CompareMode = 'single' | 'split';
type CatalogSort = 'modifiedAt' | 'fileName' | 'rating';

const tabs: { id: WorkspaceTab; label: string; icon: typeof Image }[] = [
  { id: 'library', label: '图库', icon: LibraryBig },
  { id: 'viewer', label: '看图', icon: Image },
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
    favorite: asset.favorite,
    tags: asset.tags,
    offline: asset.offline
  }));
}

function IconButton({
  label,
  children,
  active = false,
  pressed,
  onClick,
  disabled = false
}: {
  label: string;
  children: React.ReactNode;
  active?: boolean;
  pressed?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      className={`icon-button${active ? ' is-active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
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
  onImportFolders,
  onRelinkFolder,
  onUnregisterFolder,
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
  onImportFolders: () => Promise<void>;
  onRelinkFolder: (folderId: string) => Promise<void>;
  onUnregisterFolder: (folderId: string) => Promise<void>;
  onSelectTag: (tagId: string | null) => void;
  isDemo: boolean;
}): React.JSX.Element {
  const [albumManagerOpen, setAlbumManagerOpen] = useState(false);
  const [albumName, setAlbumName] = useState('');
  const [editingAlbumId, setEditingAlbumId] = useState<string | null>(null);
  const [albumBusy, setAlbumBusy] = useState(false);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [tagDeleteCandidate, setTagDeleteCandidate] = useState<string | null>(null);
  const [tagBusy, setTagBusy] = useState(false);
  const [folderRemovalCandidate, setFolderRemovalCandidate] = useState<CatalogFolder | null>(null);
  const [folderRemovalBusy, setFolderRemovalBusy] = useState(false);
  const [folderRemovalError, setFolderRemovalError] = useState('');
  const [folderAppearance, setFolderAppearance] = useState<FolderAppearance>(loadFolderAppearance);
  const [folderContextMenu, setFolderContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const visibleFolders = isDemo
    ? demoFolders.map((folder, index) => ({ id: `demo-${index}`, name: folder.name, assetCount: folder.count, offlineCount: 0, parentId: null, rootId: `demo-${index}`, depth: 0, isRoot: true }))
    : folders;
  const selectedOfflineFolder = visibleFolders.find((folder) => folder.id === selectedFolderId && folder.isRoot && folder.offlineCount > 0);
  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId && folder.isRoot);
  const libraryAssetCount = isDemo ? 12_408 : folders.length > 0 ? folders.filter((folder) => folder.isRoot).reduce((sum, folder) => sum + folder.assetCount, 0) : totalCount;
  const folderChildren = useMemo(() => {
    const children = new Map<string | null, CatalogFolder[]>();
    for (const folder of visibleFolders) {
      const siblings = children.get(folder.parentId) ?? [];
      siblings.push(folder);
      children.set(folder.parentId, siblings);
    }
    for (const siblings of children.values()) siblings.sort((left, right) => left.name.localeCompare(right.name));
    return children;
  }, [visibleFolders]);
  const displayedFolders = useMemo(() => {
    const result: CatalogFolder[] = [];
    const append = (parentId: string | null) => {
      for (const folder of folderChildren.get(parentId) ?? []) {
        result.push(folder);
        if (folderAppearance.expandedIds.includes(folder.id)) append(folder.id);
      }
    };
    append(null);
    return result;
  }, [folderAppearance.expandedIds, folderChildren]);
  const recentCount = isDemo ? 248 : smartCollections.find((collection) => collection.id === 'recent')?.assetCount ?? 0;
  const favoriteCount = isDemo ? 86 : smartCollections.find((collection) => collection.id === 'favorites')?.assetCount ?? 0;
  useEffect(() => {
    window.localStorage.setItem(FOLDER_APPEARANCE_KEY, JSON.stringify(folderAppearance));
  }, [folderAppearance]);
  useEffect(() => {
    if (!folderContextMenu) return;
    const close = () => setFolderContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('blur', close); window.removeEventListener('keydown', closeOnEscape); };
  }, [folderContextMenu]);
  useEffect(() => {
    if (!folderRemovalCandidate) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !folderRemovalBusy) setFolderRemovalCandidate(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [folderRemovalBusy, folderRemovalCandidate]);
  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
        <nav aria-label="图库导航">
          <button className={`nav-row${selectedFolderId === null && selectedAlbumId === null && selectedSmartCollection === null ? ' is-active' : ''}`} type="button" onClick={() => onSelectFolder(null)}>
            <GalleryHorizontalEnd size={15} />
            <span>所有照片</span>
            <span className="row-count">{libraryAssetCount.toLocaleString()}</span>
          </button>
          <button className={`nav-row${selectedSmartCollection === 'recent' ? ' is-active' : ''}`} type="button" onClick={() => onSelectSmartCollection(selectedSmartCollection === 'recent' ? null : 'recent')}>
            <Clock3 size={15} />
            <span>最近 30 天</span>
            <span className="row-count">{recentCount}</span>
          </button>
          <button className={`nav-row${selectedSmartCollection === 'favorites' ? ' is-active' : ''}`} type="button" onClick={() => onSelectSmartCollection(selectedSmartCollection === 'favorites' ? null : 'favorites')}>
            <Star size={15} />
            <span>首选</span>
            <span className="row-count">{favoriteCount}</span>
          </button>
        </nav>

        <div className="sidebar-section">
          <div className="section-heading">
            <button className="section-disclosure" type="button" aria-label={folderAppearance.sectionCollapsed ? '展开文件夹区域' : '收起文件夹区域'} aria-expanded={!folderAppearance.sectionCollapsed} onClick={() => setFolderAppearance((current) => ({ ...current, sectionCollapsed: !current.sectionCollapsed }))}><ChevronRight size={12} /><span>文件夹</span></button>
            <span>{selectedOfflineFolder && <button type="button" aria-label={`重新定位 ${selectedOfflineFolder.name}`} title="重新定位离线文件夹" onClick={() => void onRelinkFolder(selectedOfflineFolder.id)}><RotateCcw size={13} /></button>}{selectedFolder && <button type="button" aria-label={`从图库移除文件夹 ${selectedFolder.name}`} title="从图库移除文件夹" onClick={() => { setFolderRemovalError(''); setFolderRemovalCandidate(selectedFolder); }}><FolderMinus size={13} /></button>}<button type="button" aria-label="添加文件夹" onClick={() => void onImportFolders()}><Plus size={13} /></button></span>
          </div>
          {!folderAppearance.sectionCollapsed && displayedFolders.map((folder) => {
            const color = folderAppearance.colors[folder.id] ?? 'none';
            const expanded = folderAppearance.expandedIds.includes(folder.id);
            const hasChildren = (folderChildren.get(folder.id)?.length ?? 0) > 0;
            return <div className={`folder-entry color-${color}`} key={folder.id}>
              {hasChildren ? <button className="folder-disclosure" type="button" aria-label={`${expanded ? '收起' : '展开'} ${folder.name}`} aria-expanded={expanded} style={{ left: 3 + folder.depth * 13 }} onClick={() => setFolderAppearance((current) => ({ ...current, expandedIds: expanded ? current.expandedIds.filter((id) => id !== folder.id) : [...current.expandedIds, folder.id] }))}><ChevronRight size={11} className={expanded ? 'is-expanded' : ''} /></button> : <span className="folder-disclosure-spacer" style={{ width: 18, marginLeft: 3 + folder.depth * 13 }} />}
              <button className={`nav-row folder-row${selectedFolderId === folder.id ? ' is-selected' : ''}`} style={{ paddingLeft: 25 + folder.depth * 13 }} type="button" onClick={() => onSelectFolder(folder.id)} onContextMenu={(event) => { event.preventDefault(); setFolderContextMenu({ id: folder.id, x: event.clientX, y: event.clientY }); }}>
                <Folder size={15} />
                <span>{folder.name}</span>
                <span className="row-count">{folder.offlineCount > 0 ? `离线 ${folder.offlineCount}` : folder.assetCount}</span>
              </button>
            </div>;
          })}
          {folderContextMenu && <div className="folder-context-menu" role="menu" aria-label="文件夹菜单" style={{ left: Math.min(folderContextMenu.x, Math.max(8, window.innerWidth - 170)), top: Math.min(folderContextMenu.y, Math.max(8, window.innerHeight - 76)) }} onPointerDown={(event) => event.stopPropagation()}>
            <strong>文件夹颜色</strong><div className="folder-color-dots">{FOLDER_COLORS.map((option) => <button className={`color-${option}${(folderAppearance.colors[folderContextMenu.id] ?? 'none') === option ? ' is-active' : ''}`} type="button" role="menuitem" aria-label={option === 'none' ? '无颜色' : `${option} 色`} key={option} onClick={() => { setFolderAppearance((current) => ({ ...current, colors: { ...current.colors, [folderContextMenu.id]: option } })); setFolderContextMenu(null); }}><span />{(folderAppearance.colors[folderContextMenu.id] ?? 'none') === option && <Check size={10} />}</button>)}</div>
          </div>}
        </div>

        {!isDemo && <div className="sidebar-section"><div className="section-heading"><span>相册</span><button type="button" aria-label="管理相册" onClick={() => { setAlbumManagerOpen(true); setEditingAlbumId(null); setAlbumName(''); }}><Plus size={13} /></button></div>{albums.length === 0 ? <small className="sidebar-empty">暂无相册</small> : albums.map((album) => <button className={`nav-row folder-row${selectedAlbumId === album.id ? ' is-selected' : ''}`} type="button" key={album.id} onClick={() => onSelectAlbum(selectedAlbumId === album.id ? null : album.id)}><FolderHeart size={15} /><span>{album.name}</span><span className="row-count">{album.assetCount}</span></button>)}</div>}

        <div className="sidebar-section">
          <div className="section-heading"><span>智能集合</span></div>
          {(isDemo ? [{ id: 'unanalyzed', assetCount: 43 }, { id: 'generated', assetCount: 27 }] : smartCollections.filter((collection) => collection.id !== 'recent' && collection.id !== 'favorites')).map((collection) => { const label = collection.id === 'unrated' ? '未评分' : collection.id === 'unanalyzed' ? '等待 AI 分析' : collection.id === 'to-review' ? '待审阅' : '已生成'; const Icon = collection.id === 'generated' ? FolderHeart : collection.id === 'to-review' ? Check : collection.id === 'unrated' ? CircleAlert : Sparkles; return <button className={`nav-row${selectedSmartCollection === collection.id ? ' is-active' : ''}`} type="button" key={collection.id} onClick={() => onSelectSmartCollection(selectedSmartCollection === collection.id ? null : collection.id as CatalogSmartCollection['id'])}><Icon size={15} /><span>{label}</span><span className="row-count">{collection.assetCount}</span></button>; })}
        </div>

        <div className="sidebar-section">
          <div className="section-heading"><span>标签</span><button type="button" aria-label="管理标签" disabled={isDemo} onClick={() => { setTagDeleteCandidate(null); setTagManagerOpen(true); }}><Tags size={13} /></button></div>
          <div className="tag-cloud">
            {isDemo ? <><span>人像</span><span>夜景</span><span>街拍</span><span>自然光</span></> : tags.length === 0 ? <small>暂无标签</small> : tags.map((tag) => <button className={selectedTagId === tag.id ? 'is-active' : ''} type="button" key={tag.id} onClick={() => onSelectTag(selectedTagId === tag.id ? null : tag.id)}>{tag.name}<em>{tag.assetCount}</em></button>)}
          </div>
        </div>
      </div>
      <div className="library-summary">
        <span>本地图库</span>
        <strong>{isDemo ? demoFolders.length : folders.filter((folder) => folder.isRoot).length} 个文件夹 · {libraryAssetCount.toLocaleString()} 张照片</strong>
      </div>
      {albumManagerOpen && <div className="modal-backdrop sidebar-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !albumBusy) setAlbumManagerOpen(false); }}><form className="album-dialog" role="dialog" aria-modal="true" aria-labelledby="album-dialog-title" onSubmit={async (event) => { event.preventDefault(); if (!albumName.trim() || albumBusy) return; setAlbumBusy(true); try { await window.desktopApi.saveCatalogAlbum({ id: editingAlbumId ?? undefined, name: albumName }); await onRefreshAlbums(); setAlbumName(''); setEditingAlbumId(null); } finally { setAlbumBusy(false); } }}><header><div><span className="dialog-icon"><FolderHeart size={16} /></span><div><h2 id="album-dialog-title">管理相册</h2><p>相册只管理图库关系，不会移动原文件。</p></div></div><IconButton label="关闭相册管理" onClick={() => setAlbumManagerOpen(false)}><X size={15} /></IconButton></header><div className="album-list">{albums.map((album) => <div className={`album-row${editingAlbumId === album.id ? ' is-selected' : ''}`} key={album.id}><button type="button" onClick={() => { setEditingAlbumId(album.id); setAlbumName(album.name); }}><FolderHeart size={14} /><span>{album.name}</span><small>{album.assetCount} 张</small></button><button type="button" aria-label={`删除相册 ${album.name}`} onClick={async () => { if (albumBusy) return; setAlbumBusy(true); try { await window.desktopApi.deleteCatalogAlbum(album.id); if (selectedAlbumId === album.id) onSelectAlbum(null); await onRefreshAlbums(); } finally { setAlbumBusy(false); } }}><Trash2 size={13} /></button></div>)}</div><label className="album-field"><span>{editingAlbumId ? '重命名相册' : '新建相册'}</span><input autoFocus value={albumName} maxLength={120} placeholder="例如：客户交付" onChange={(event) => setAlbumName(event.target.value)} /></label><footer><button className="quiet-button" type="button" onClick={() => setAlbumManagerOpen(false)}>关闭</button><button className="primary-action compact" type="submit" disabled={!albumName.trim() || albumBusy}>{editingAlbumId ? '保存名称' : '创建相册'}</button></footer></form></div>}
      {tagManagerOpen && <div className="modal-backdrop sidebar-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !tagBusy) setTagManagerOpen(false); }}><section className="album-dialog tag-dialog" role="dialog" aria-modal="true" aria-labelledby="tag-dialog-title"><header><div><span className="dialog-icon"><Tags size={16} /></span><div><h2 id="tag-dialog-title">管理标签</h2><p>删除标签只会移除标签关系，不会删除照片或文件。</p></div></div><IconButton label="关闭标签管理" disabled={tagBusy} onClick={() => setTagManagerOpen(false)}><X size={15} /></IconButton></header><div className="tag-list">{tags.length === 0 ? <div className="operation-history-empty">暂无可管理标签</div> : tags.map((tag) => <div className={`tag-manager-row${tagDeleteCandidate === tag.id ? ' is-pending' : ''}`} key={tag.id}><span><strong>{tag.name}</strong><small>{tag.assetCount} 张照片</small></span>{tagDeleteCandidate === tag.id ? <div><button className="quiet-button" type="button" disabled={tagBusy} onClick={() => setTagDeleteCandidate(null)}>取消</button><button className="danger-action compact" type="button" disabled={tagBusy} onClick={async () => { setTagBusy(true); try { await window.desktopApi.deleteCatalogTag(tag.id); if (selectedTagId === tag.id) onSelectTag(null); await onRefreshAlbums(); setTagDeleteCandidate(null); } finally { setTagBusy(false); } }}>确认删除</button></div> : <button type="button" aria-label={`删除标签 ${tag.name}`} onClick={() => setTagDeleteCandidate(tag.id)}><Trash2 size={13} /></button>}</div>)}</div><footer><button className="quiet-button" type="button" disabled={tagBusy} onClick={() => setTagManagerOpen(false)}>关闭</button></footer></section></div>}
      {folderRemovalCandidate && <div className="modal-backdrop sidebar-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !folderRemovalBusy) setFolderRemovalCandidate(null); }}><section className="removal-dialog" role="alertdialog" aria-modal="true" aria-labelledby="folder-removal-title" aria-describedby="folder-removal-description"><header><span className="dialog-icon"><FolderMinus size={17} /></span><div><h2 id="folder-removal-title">从图库移除文件夹「{folderRemovalCandidate.name}」？</h2><p id="folder-removal-description">只会取消此图库对文件夹的管理，不会删除、移动或修改磁盘上的任何文件。</p></div></header><div className="removal-impact"><Info size={15} /><span>其中 {folderRemovalCandidate.assetCount} 张照片会从图库和搜索结果中隐藏。AI 分析、生成版本、评分、标签和相册关系都会保留，重新导入同一路径后自动恢复。</span></div>{folderRemovalError && <div className="folder-removal-error" role="alert"><CircleAlert size={14} /><span>{folderRemovalError}</span></div>}<footer><button autoFocus className="quiet-button" type="button" disabled={folderRemovalBusy} onClick={() => setFolderRemovalCandidate(null)}>取消</button><button className="primary-action compact" type="button" disabled={folderRemovalBusy} onClick={async () => { setFolderRemovalBusy(true); setFolderRemovalError(''); try { await onUnregisterFolder(folderRemovalCandidate.id); setFolderRemovalCandidate(null); } catch (error) { const message = error instanceof Error ? error.message : String(error); setFolderRemovalError(message.includes('FOLDER_HAS_ACTIVE_TASKS') ? '此文件夹仍有正在运行或等待中的 AI 任务，请先取消或完成任务。' : message.includes('FOLDER_HAS_ACTIVE_FILE_OPERATIONS') ? '此文件夹仍有未完成的文件操作，请等待操作完成或恢复后重试。' : '无法移除此文件夹。请刷新图库后重试。'); } finally { setFolderRemovalBusy(false); } }}>{folderRemovalBusy ? '正在移除…' : '仅从图库移除'}</button></footer></section></div>}
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
  favoriteOnly,
  onFavoriteOnlyChange,
  sortBy,
  onSortByChange,
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
  favoriteOnly: boolean;
  onFavoriteOnlyChange: (value: boolean) => void;
  sortBy: CatalogSort;
  onSortByChange: (value: CatalogSort) => void;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, scrollLeft: 0 });
  const [filterOpen, setFilterOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'filmstrip' | 'grid'>('filmstrip');
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
          <div className="filter-control"><button className={`quiet-button${favoriteOnly ? ' is-active' : ''}`} type="button" aria-expanded={filterOpen} onClick={() => setFilterOpen((value) => !value)}><ListFilter size={14} /> 筛选{favoriteOnly ? ' · 首选' : ''}</button>{filterOpen && <div className="filter-popover" role="dialog" aria-label="图库筛选"><label><input type="checkbox" checked={favoriteOnly} onChange={(event) => onFavoriteOnlyChange(event.target.checked)} />仅显示首选照片</label><button className="quiet-button" type="button" onClick={() => { onFavoriteOnlyChange(false); setFilterOpen(false); }}>清除筛选</button></div>}</div>
          <label className="sort-control"><select aria-label="图库排序" value={sortBy} onChange={(event) => onSortByChange(event.target.value as CatalogSort)}><option value="modifiedAt">拍摄时间</option><option value="fileName">文件名</option><option value="rating">评分</option></select><ChevronDown size={12} /></label>
          <div className="segmented-control">
            <button className={viewMode === 'filmstrip' ? 'is-active' : ''} type="button" aria-label="胶片视图" aria-pressed={viewMode === 'filmstrip'} onClick={() => setViewMode('filmstrip')}><GalleryHorizontalEnd size={14} /></button>
            <button className={viewMode === 'grid' ? 'is-active' : ''} type="button" aria-label="网格视图" aria-pressed={viewMode === 'grid'} onClick={() => setViewMode('grid')}><Grid2X2 size={14} /></button>
          </div>
        </div>
      </div>
      <div className={`filmstrip${viewMode === 'grid' ? ' is-grid' : ''}`} role="listbox" aria-label="照片" ref={viewportRef} onScroll={(event) => {
        const element = event.currentTarget;
        setViewport((current) => ({ ...current, scrollLeft: element.scrollLeft }));
        if (hasMore && !loading && (viewMode === 'grid' ? element.scrollTop + element.clientHeight >= element.scrollHeight - 220 : element.scrollLeft + element.clientWidth >= element.scrollWidth - itemSize * 3)) onLoadMore();
      }}>
        <div className="filmstrip-track" style={viewMode === 'grid' ? undefined : { width: virtual.totalSize + (hasMore ? itemSize : 0) }}>
        {(viewMode === 'grid' ? items : visibleItems).map((photo, visibleIndex) => {
          const index = viewMode === 'grid' ? visibleIndex : virtual.start + visibleIndex;
          return (
          <button
            className={`thumb${selected.id === photo.id ? ' is-selected' : ''}${photo.offline ? ' is-offline' : ''}`}
            key={photo.id}
            style={viewMode === 'grid' ? undefined : { left: index * itemSize }}
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
            {photo.offline && <i className="offline-badge">离线</i>}
            {selection.selectedIds.has(photo.id) && <span className="selection-check"><Check size={11} /></span>}
            <span className="thumb-name">{photo.fileName}</span>
          </button>
          );
        })}
        {hasMore && <button className="filmstrip-more" type="button" style={viewMode === 'grid' ? undefined : { left: items.length * itemSize }} onClick={onLoadMore} disabled={loading}>{loading ? '加载中' : '更多'}</button>}
        </div>
      </div>
    </section>
  );
}

function Viewer({
  photo,
  results,
  isDemo,
  exportPresets,
  selectedExportPresetId,
  trackedExportNotice,
  onExportPresetChange,
  onExport,
  onRate,
  onFavorite,
  onRegenerate,
  onEditTags,
  onMove,
  onCopy,
  onRename,
  onRemove,
  onTrash,
  onReview,
  onRevealOriginal,
  onRevealResult
}: {
  photo: Photo;
  results: GenerationResult[];
  isDemo: boolean;
  exportPresets: ExportPreset[];
  selectedExportPresetId: string | null;
  trackedExportNotice: string;
  onExportPresetChange: (presetId: string | null) => void;
  onExport: (resultIds: string[], presetId?: string | null) => Promise<string>;
  onRate: (rating: number) => void;
  onFavorite: (favorite: boolean) => void;
  onRegenerate: (result: GenerationResult) => Promise<string>;
  onEditTags: () => void;
  onMove: () => void;
  onCopy: () => void;
  onRename: () => void;
  onRemove: () => void;
  onTrash: () => void;
  onReview: (resultId: string, reviewState: GenerationResult['reviewState']) => Promise<void>;
  onRevealOriginal: () => void;
  onRevealResult: (resultId: string) => void;
}): React.JSX.Element {
  const [compareMode, setCompareMode] = useState<CompareMode>('single');
  const [split, setSplit] = useState(52);
  const [showOriginal, setShowOriginal] = useState(false);
  const [selectedResultId, setSelectedResultId] = useState<string | null>(results[0]?.id ?? null);
  const [exportNotice, setExportNotice] = useState('');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panOriginRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [imageAspectRatio, setImageAspectRatio] = useState(3 / 2);
  const [fittedSize, setFittedSize] = useState({ width: 0, height: 0 });
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const latestResultId = results[0]?.id ?? null;
  const selectedResult = selectedResultId ? results.find((result) => result.id === selectedResultId) : undefined;
  const generatedSource = isDemo ? photo.src : selectedResult?.resultUrl;

  useEffect(() => {
    setSelectedResultId(latestResultId);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [photo.id, latestResultId]);

  useLayoutEffect(() => {
    const container = canvasWrapRef.current;
    if (!container) return;
    const fit = () => {
      const availableWidth = Math.max(1, container.clientWidth - 36);
      const availableHeight = Math.max(1, container.clientHeight - 36);
      const width = Math.min(availableWidth, availableHeight * imageAspectRatio);
      setFittedSize({ width, height: width / imageAspectRatio });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    return () => observer.disconnect();
  }, [imageAspectRatio]);

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

  const adjustZoom = (factor: number) => {
    setZoom((current) => {
      const next = Math.min(4, Math.max(0.25, Math.round(current * factor * 100) / 100));
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };
  const captureAspectRatio = useCallback((image: HTMLImageElement) => {
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      setImageAspectRatio(image.naturalWidth / image.naturalHeight);
    }
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
          <IconButton label="缩小" disabled={zoom <= 0.25} onClick={() => adjustZoom(0.8)}><ZoomOut size={15} /></IconButton>
          <span className="zoom-value" aria-live="polite">{Math.round(zoom * 100)}%</span>
          <IconButton label="放大" disabled={zoom >= 4} onClick={() => adjustZoom(1.25)}><ZoomIn size={15} /></IconButton>
          <IconButton label="适应窗口" active={zoom === 1} pressed={zoom === 1} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}><Maximize2 size={15} /></IconButton>
          {selectedResult && !isDemo && <span className="review-actions"><button type="button" aria-label="接受当前版本" className={selectedResult.reviewState === 'accepted' ? 'is-review-active' : ''} onClick={() => void onReview(selectedResult.id, 'accepted')}>接受</button><button type="button" aria-label="标记为首选" className={selectedResult.reviewState === 'preferred' ? 'is-review-active' : ''} onClick={() => void onReview(selectedResult.id, 'preferred')}><Star size={12} />首选</button><button type="button" aria-label="拒绝当前版本" className={selectedResult.reviewState === 'rejected' ? 'is-review-rejected' : ''} onClick={() => void onReview(selectedResult.id, 'rejected')}>拒绝</button></span>}
        </div>
      </div>
      <div className={`canvas-wrap${zoom > 1 ? ' is-zoomed' : ''}`} ref={canvasWrapRef} onWheel={(event) => {
        if (event.ctrlKey || event.metaKey || event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
          event.preventDefault();
          adjustZoom(event.deltaY < 0 ? 1.12 : 0.89);
        } else if (zoom > 1) {
          event.preventDefault();
          setPan((current) => ({ x: current.x - event.deltaX, y: current.y - event.deltaY }));
        }
      }} onPointerDown={(event) => {
        if (zoom <= 1 || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        panOriginRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
        event.currentTarget.classList.add('is-panning');
      }} onPointerMove={(event) => {
        const origin = panOriginRef.current;
        if (!origin) return;
        setPan({ x: origin.panX + event.clientX - origin.x, y: origin.panY + event.clientY - origin.y });
      }} onPointerUp={(event) => {
        panOriginRef.current = null;
        event.currentTarget.classList.remove('is-panning');
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }} onPointerCancel={(event) => {
        panOriginRef.current = null;
        event.currentTarget.classList.remove('is-panning');
      }}>
        <div
          className={`photo-canvas${compareMode === 'split' ? ' is-comparing' : ''}`}
          style={{ width: fittedSize.width, height: fittedSize.height, transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}
          onDoubleClick={() => { setPan({ x: 0, y: 0 }); setZoom((current) => current === 1 ? 2 : 1); }}
        >
          <div className="preview-unavailable"><Image size={36} /><strong>预览暂不可用</strong><span>图像服务将在后台生成屏幕预览</span></div>
          {photo.src ? <BufferedPreviewImage className="base-image" src={photo.src} alt={photo.fileName} onReady={captureAspectRatio} /> : null}
          {generatedSource && !showOriginal && (
            <div
              className="generated-layer"
              style={compareMode === 'split' ? { clipPath: `inset(0 ${100 - split}% 0 0)` } : undefined}
            >
              <img src={generatedSource} alt="AI 生成版本" onLoad={(event) => { if (!photo.src) captureAspectRatio(event.currentTarget); }} onError={(event) => { event.currentTarget.style.display = 'none'; }} />
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
        <div className="viewer-meta-actions"><div className="rating">{[1, 2, 3, 4, 5].map((value) => <button type="button" aria-label={`设置评分 ${value}`} key={value} onClick={() => onRate(photo.rating === value ? 0 : value)}><Star size={13} fill={value <= photo.rating ? 'currentColor' : 'none'} /></button>)}</div>{!isDemo && <IconButton label={photo.favorite ? '取消收藏照片' : '收藏照片'} active={Boolean(photo.favorite)} pressed={Boolean(photo.favorite)} onClick={() => onFavorite(!photo.favorite)}><Heart size={13} fill={photo.favorite ? 'currentColor' : 'none'} /></IconButton>}{!isDemo && <><IconButton label="在文件管理器中显示原图" onClick={onRevealOriginal}><FolderOpen size={13} /></IconButton><IconButton label="重命名照片" onClick={onRename}><FilePenLine size={13} /></IconButton><IconButton label="复制到文件夹" onClick={onCopy}><Copy size={13} /></IconButton><IconButton label="移动到文件夹" onClick={onMove}><FolderInput size={13} /></IconButton><IconButton label="仅从图库移除" onClick={onRemove}><LibraryBig size={13} /></IconButton><IconButton label="移到系统回收站" onClick={onTrash}><Trash2 size={13} /></IconButton></>}<IconButton label="添加标签" onClick={onEditTags}><Tags size={13} /></IconButton></div>
        <div className="version-switcher">
          <button type="button" onMouseDown={() => setShowOriginal(true)} onMouseUp={() => setShowOriginal(false)} onMouseLeave={() => setShowOriginal(false)}>
            按住查看原图 <kbd>O</kbd>
          </button>
          <span />
          <button className={!selectedResult && !isDemo ? 'is-current' : ''} type="button" onClick={() => setSelectedResultId(null)}>原图</button>
          {isDemo ? <><button type="button">V1</button><button className="is-current" type="button">V2</button></> : [...results].reverse().map((result) => (
            <button className={`version-button${selectedResult?.id === result.id ? ' is-current' : ''}${result.reviewState === 'preferred' ? ' is-preferred' : result.reviewState === 'rejected' ? ' is-rejected' : ''}`} type="button" key={result.id} onClick={() => setSelectedResultId(result.id)} title={result.reviewState === 'preferred' ? '首选' : result.reviewState === 'accepted' ? '已接受' : result.reviewState === 'rejected' ? '已拒绝' : '未审阅'}>V{result.version}</button>
          ))}
          <button type="button" title="按当前方案再次生成" aria-label="按当前方案再次生成" disabled={!selectedResult || isDemo} onClick={() => {
            if (!selectedResult) return;
            void onRegenerate(selectedResult).then(setExportNotice);
          }}><RotateCcw size={13} /></button>
          <select aria-label="导出预设" value={selectedExportPresetId ?? ''} onChange={(event) => onExportPresetChange(event.target.value || null)}>
            <option value="">默认命名</option>
            {exportPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
          <button type="button" title="导出当前版本" aria-label="导出当前版本" disabled={!selectedResult || isDemo} onClick={() => {
            if (!selectedResult) return;
            void onExport([selectedResult.id], selectedExportPresetId).then(setExportNotice);
          }}><Download size={13} /></button>
          <button type="button" title="在文件管理器中显示生成版本" aria-label="在文件管理器中显示生成版本" disabled={!selectedResult || isDemo} onClick={() => { if (selectedResult) onRevealResult(selectedResult.id); }}><FolderOpen size={13} /></button>
          {(trackedExportNotice || exportNotice) && <em className="viewer-notice" role="status">{trackedExportNotice || exportNotice}</em>}
        </div>
        <div className="file-meta"><span>{photo.format}</span><span>{photo.dimensions}</span></div>
      </div>
    </section>
  );
}

function AiPanel({
  photo,
  results,
  trashedResults,
  revision,
  isDemo,
  notice,
  onAnalyze,
  generationProfiles,
  templates,
  onOpenTemplates,
  onGenerate,
  onTrashResult,
  onRestoreResult
}: {
  photo: Photo;
  results: GenerationResult[];
  trashedResults: TrashedGenerationResult[];
  revision: AnalysisRevision | undefined;
  isDemo: boolean;
  notice: string;
  onAnalyze: () => void;
  generationProfiles: ProviderProfile[];
  templates: PromptTemplate[];
  onOpenTemplates: () => void;
  onGenerate: (input: { providerProfileId: string; template: PromptTemplate | null; count: number; instruction: string; disabledActionIds: Set<string> }) => Promise<string>;
  onTrashResult: (resultId: string) => Promise<void>;
  onRestoreResult: (resultId: string) => Promise<void>;
}): React.JSX.Element {
  const [actions, setActions] = useState({ people: true, light: true, texture: false });
  const [disabledActions, setDisabledActions] = useState<Set<string>>(new Set());
  const [generationCount, setGenerationCount] = useState(3);
  const [templateId, setTemplateId] = useState('');
  const [instruction, setInstruction] = useState('保持自然皮肤纹理，不要过度磨皮。');
  const [generationNotice, setGenerationNotice] = useState('');
  const [generating, setGenerating] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<'ai' | 'info' | 'versions'>('ai');

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
      <div className="inspector-tabs"><button className={inspectorTab === 'ai' ? 'is-active' : ''} type="button" aria-selected={inspectorTab === 'ai'} onClick={() => setInspectorTab('ai')}><Bot size={14} />AI</button><button className={inspectorTab === 'info' ? 'is-active' : ''} type="button" aria-selected={inspectorTab === 'info'} onClick={() => setInspectorTab('info')}><Info size={14} />信息</button><button className={inspectorTab === 'versions' ? 'is-active' : ''} type="button" aria-selected={inspectorTab === 'versions'} onClick={() => setInspectorTab('versions')}><Layers3 size={14} />版本</button></div>
      <div className="inspector-scroll">{inspectorTab === 'ai' ? <>
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
          <div className="inspector-heading"><span>提示词模板</span><button type="button" onClick={onOpenTemplates}>浏览模板</button></div>
          {isDemo ? <button className="template-choice" type="button" onClick={onOpenTemplates}><span className="template-preview"><img src="./demo/portrait.jpg" alt="" /></span><span><strong>自然人像 · 清洁背景</strong><small>保留身份、服装与真实光线</small></span><ChevronRight size={15} /></button> : (
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
      </> : inspectorTab === 'info' ? <InspectorInfo photo={photo} revision={revision} /> : <InspectorVersions results={results} trashedResults={trashedResults} onTrashResult={onTrashResult} onRestoreResult={onRestoreResult} />}</div>
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

function InspectorInfo({ photo, revision }: { photo: Photo; revision: AnalysisRevision | undefined }): React.JSX.Element {
  const fields = [
    ['文件名', photo.fileName],
    ['格式', photo.format],
    ['尺寸', photo.dimensions],
    ['评分', `${photo.rating} / 5`],
    ['AI 状态', revision ? '已分析' : '未分析']
  ];
  return <div className="inspector-info"><section className="inspector-section"><div className="inspector-heading"><span>文件信息</span></div><div className="metadata-list">{fields.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></section><section className="inspector-section"><div className="inspector-heading"><span>用户标签</span><span className="section-count">{photo.tags?.length ?? 0} 个</span></div>{photo.tags?.length ? <div className="metadata-tags">{photo.tags.map((tag) => <span key={tag.id}>{tag.name}</span>)}</div> : <div className="inline-empty">尚未添加标签</div>}</section>{revision && <section className="inspector-section"><div className="inspector-heading"><span>AI 编目</span></div><p className="analysis-copy">{revision.result.catalog.shortDescription}</p></section>}</div>;
}

function InspectorVersions({ results, trashedResults, onTrashResult, onRestoreResult }: { results: GenerationResult[]; trashedResults: TrashedGenerationResult[]; onTrashResult: (resultId: string) => Promise<void>; onRestoreResult: (resultId: string) => Promise<void> }): React.JSX.Element {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const run = async (resultId: string, operation: (id: string) => Promise<void>) => {
    setBusyId(resultId);
    try {
      await operation(resultId);
      setPendingId(null);
    } catch {
      // The workspace operation reports a specific failure through its status toast.
    } finally {
      setBusyId(null);
    }
  };
  return <div className="inspector-versions">
    <section className="inspector-section">
      <div className="inspector-heading"><span>生成版本</span><span className="section-count">{results.length} 个</span></div>
      {results.length === 0 ? <div className="inline-empty">尚无可用版本</div> : <div className="version-list">{[...results].sort((a, b) => b.version - a.version).map((result) => <div className={`version-list-row${pendingId === result.id ? ' is-pending' : ''}`} key={result.id}>
        <span><strong>V{result.version}</strong><small>{result.reviewState === 'preferred' ? '首选' : result.reviewState === 'accepted' ? '已接受' : result.reviewState === 'rejected' ? '已拒绝' : '未审阅'}</small></span>
        {pendingId === result.id ? <span className="version-confirm"><button type="button" disabled={busyId !== null} onClick={() => setPendingId(null)}>取消</button><button className="is-danger" type="button" disabled={busyId !== null} onClick={() => void run(result.id, onTrashResult)}>{busyId === result.id ? '回收中' : '确认'}</button></span> : <span className="version-row-actions"><em>{new Date(result.createdAt).toLocaleDateString()}</em><button type="button" aria-label={`回收版本 V${result.version}`} disabled={busyId !== null} onClick={() => setPendingId(result.id)}><Trash2 size={12} /></button></span>}
      </div>)}</div>}
    </section>
    {trashedResults.length > 0 && <section className="inspector-section recycle-section">
      <div className="inspector-heading"><span>版本回收站</span><span className="section-count">{trashedResults.length} 个</span></div>
      <div className="version-list">{trashedResults.map((result) => <div className="version-list-row is-trashed" key={result.id}>
        <span><strong>V{result.version}</strong><small>{new Date(result.trashedAt).toLocaleString()}</small></span>
        <button type="button" aria-label={`恢复版本 V${result.version}`} title="恢复版本" disabled={busyId !== null} onClick={() => void run(result.id, onRestoreResult)}><RotateCcw className={busyId === result.id ? 'is-spinning' : ''} size={12} /></button>
      </div>)}</div>
    </section>}
  </div>;
}

function TaskBar({ open, onToggle, onOpenTaskCenter, tasks }: { open: boolean; onToggle: () => void; onOpenTaskCenter: () => void; tasks: PersistedTask[] | null }): React.JSX.Element {
  const isDemo = tasks === null;
  const visibleTasks = tasks ?? [];
  const runningCount = isDemo ? 1 : visibleTasks.filter((task) => ['preparing', 'uploading', 'processing', 'downloading', 'saving'].includes(task.status)).length;
  const waitingCount = isDemo ? 4 : visibleTasks.filter((task) => task.status === 'queued').length;
  const failedCount = isDemo ? 1 : visibleTasks.filter((task) => task.status === 'failed').length;
  const pausedCount = isDemo ? 0 : visibleTasks.filter((task) => task.status === 'paused').length;

  return (
    <>
      {open && (
        <div className="task-drawer">
          <div className="drawer-head"><div><strong>当前任务</strong><span>生成任务将按顺序执行</span></div><div><button className="quiet-button" type="button" onClick={onOpenTaskCenter}><ListFilter size={13} />任务中心</button><IconButton label="关闭任务抽屉" onClick={onToggle}><X size={15} /></IconButton></div></div>
          {isDemo ? <><div className="task-row is-running"><span className="drag-handle">⠿</span><img src="./demo/portrait.jpg" alt="" /><span className="task-title"><strong>DSC_4821.NEF</strong><small>自然人像 · 清洁背景</small></span><span className="task-progress"><i style={{ width: '64%' }} /><em>正在生成 · 64%</em></span><span className="task-time">约 18 秒</span><IconButton label="暂停"><Pause size={14} /></IconButton></div><div className="task-row"><span className="drag-handle">⠿</span><img src="./demo/coast.jpg" alt="" /><span className="task-title"><strong>A7R_0938.ARW</strong><small>自然风光 · 清除游客</small></span><span className="queued-label">队列第 1 位</span><span className="task-time">生成 2 次</span><IconButton label="开始"><Play size={14} /></IconButton></div></> : visibleTasks.length === 0 ? <div className="drawer-empty">暂无任务</div> : visibleTasks.slice(0, 2).map((task) => <div className="task-row" key={task.id}><span className="drag-handle">⠿</span><span className="task-placeholder-image"><TaskKindIcon kind={task.kind} /></span><span className="task-title"><strong>{taskLabels[task.kind]}</strong><small>{taskSubtitle(task)}</small></span><span className="task-progress"><i style={{ width: `${task.progress * 100}%` }} /><em>{statusLabels[task.status]} · {Math.round(task.progress * 100)}%</em></span><span className="task-time">第 {task.attempt + 1} 次</span><span /></div>)}
        </div>
      )}
      <button className="task-statusbar" type="button" onClick={onToggle} aria-expanded={open}>
        <span className={`working-pulse${runningCount === 0 ? ' is-idle' : ''}`} /><strong>处理中 {runningCount}</strong><span>等待 {waitingCount}</span>{pausedCount > 0 && <span>暂停 {pausedCount}</span>}<span className="failed-count">失败 {failedCount}</span><span className="status-spacer" /><span>串行任务</span><PanelBottomOpen size={15} className={open ? 'is-open' : ''} />
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
  exportPresets: ExportPreset[];
  isDemo: boolean;
  selectedFolderId: string | null;
  selectedAlbumId: string | null;
  selectedSmartCollection: CatalogSmartCollection['id'] | null;
  selectedTagId: string | null;
  totalCount: number;
  favoriteOnly: boolean;
  onFavoriteOnlyChange: (value: boolean) => void;
  sortBy: CatalogSort;
  onSortByChange: (value: CatalogSort) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onSelectFolder: (folderId: string | null) => void;
  onSelectAlbum: (albumId: string | null) => void;
  onSelectSmartCollection: (id: CatalogSmartCollection['id'] | null) => void;
  onRefreshAlbums: () => Promise<void>;
  onImportFolders: () => Promise<void>;
  onRelinkFolder: (folderId: string) => Promise<void>;
  onUnregisterFolder: (folderId: string) => Promise<void>;
  onSelectTag: (tagId: string | null) => void;
  onLoadMore: () => void;
  searchQuery: string;
  selectedAssetId: string | null;
  onSelectedAssetChange: (assetId: string | null) => void;
  onRefreshCatalog: () => Promise<void>;
  onOpenTaskCenter: () => void;
  onOpenTemplates: () => void;
};

function LibraryWorkspace(props: LibraryWorkspaceProps): React.JSX.Element {
  const [operationNotice, setOperationNotice] = useState('');
  const unregisterFolder = async (folderId: string) => {
    const folder = props.catalogFolders.find((item) => item.id === folderId);
    await props.onUnregisterFolder(folderId);
    setOperationNotice(`已从图库移除「${folder?.name ?? '文件夹'}」，磁盘文件和已有元数据保持不变。`);
  };
  if (props.availablePhotos.length > 0) {
    return <PopulatedLibraryWorkspace {...props} onUnregisterFolder={unregisterFolder} operationNotice={operationNotice} setOperationNotice={setOperationNotice} />;
  }
  return (
    <div className="workspace">
      <Sidebar folders={props.catalogFolders} albums={props.catalogAlbums} smartCollections={props.catalogSmartCollections} totalCount={props.totalCount} selectedFolderId={props.selectedFolderId} selectedAlbumId={props.selectedAlbumId} selectedSmartCollection={props.selectedSmartCollection} tags={props.catalogTags} selectedTagId={props.selectedTagId} onSelectFolder={props.onSelectFolder} onSelectAlbum={props.onSelectAlbum} onSelectSmartCollection={props.onSelectSmartCollection} onRefreshAlbums={props.onRefreshAlbums} onImportFolders={props.onImportFolders} onRelinkFolder={props.onRelinkFolder} onUnregisterFolder={unregisterFolder} onSelectTag={props.onSelectTag} isDemo={props.isDemo} />
      <main className="empty-library-main">
        {props.catalogFolders.length === 0 ? <FolderOpen size={30} /> : <Search size={30} />}
        <h2>{props.catalogFolders.length === 0 ? '添加照片文件夹' : props.searchQuery ? '没有匹配的照片' : '此集合为空'}</h2>
        <p>{props.catalogFolders.length === 0 ? '照片仍保留在原位置，PhotoAllIsAI 只建立本地图库索引。' : props.searchQuery ? '尝试其他文件名、场景、主体或 AI 关键词。' : '从其他目录选择照片，或导入新的照片文件夹。'}</p>
        {props.catalogFolders.length === 0 && <button className="primary-action compact" type="button" onClick={() => void props.onImportFolders()}><Plus size={14} />选择文件夹</button>}
      </main>
      <aside className="empty-library-inspector"><Info size={18} /><span>选择照片后显示分析和版本信息</span></aside>
      {operationNotice && <div className="operation-toast" role="status">{operationNotice}<button type="button" aria-label="关闭提示" onClick={() => setOperationNotice('')}><X size={13} /></button></div>}
      <TaskBar open={false} onToggle={() => undefined} onOpenTaskCenter={props.onOpenTaskCenter} tasks={[]} />
    </div>
  );
}

function collectionTitle(props: Pick<LibraryWorkspaceProps, 'catalogFolders' | 'catalogAlbums' | 'selectedFolderId' | 'selectedAlbumId' | 'selectedSmartCollection' | 'searchQuery'>): string {
  if (props.selectedFolderId) return props.catalogFolders.find((folder) => folder.id === props.selectedFolderId)?.name ?? '文件夹';
  if (props.selectedAlbumId) return props.catalogAlbums.find((album) => album.id === props.selectedAlbumId)?.name ?? '相册';
  if (props.selectedSmartCollection) {
    return props.selectedSmartCollection === 'recent' ? '最近 30 天'
      : props.selectedSmartCollection === 'favorites' ? '首选照片'
        : props.selectedSmartCollection === 'unrated' ? '未评分'
          : props.selectedSmartCollection === 'unanalyzed' ? '等待 AI 分析'
            : props.selectedSmartCollection === 'to-review' ? '待审阅' : '已生成';
  }
  return props.searchQuery ? `搜索：${props.searchQuery}` : '所有照片';
}

function CatalogWorkspace(props: LibraryWorkspaceProps & { onOpenViewer: (assetId: string) => void }): React.JSX.Element {
  const initialId = props.availablePhotos.some((photo) => photo.id === props.selectedAssetId)
    ? props.selectedAssetId
    : props.availablePhotos[0]?.id ?? null;
  const [selection, setSelection] = useState<SelectionState>({
    selectedIds: new Set(initialId ? [initialId] : []),
    anchorId: initialId,
    focusId: initialId
  });
  const [tagDraft, setTagDraft] = useState('');
  const [albumTargetId, setAlbumTargetId] = useState('');
  const [notice, setNotice] = useState('');
  const gridRef = useRef<HTMLElement>(null);
  const marqueeOriginRef = useRef<{ x: number; y: number; additive: boolean; initialIds: Set<string> } | null>(null);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const orderedIds = useMemo(() => props.availablePhotos.map((photo) => photo.id), [props.availablePhotos]);
  const selectedPhoto = props.availablePhotos.find((photo) => selection.focusId === photo.id) ?? null;

  useEffect(() => {
    const visible = new Set(orderedIds);
    const retained = [...selection.selectedIds].filter((id) => visible.has(id));
    if (retained.length === selection.selectedIds.size) return;
    const fallback = orderedIds[0] ?? null;
    setSelection({ selectedIds: new Set(retained.length > 0 ? retained : fallback ? [fallback] : []), anchorId: retained[0] ?? fallback, focusId: retained.at(-1) ?? fallback });
  }, [orderedIds, selection.selectedIds]);

  const selectPhoto = (photo: Photo, intent: SelectionIntent) => {
    const next = updateSelection(selection, orderedIds, photo.id, intent);
    setSelection(next);
    props.onSelectedAssetChange(photo.id);
  };
  const moveGridFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || orderedIds.length === 0) return;
    event.preventDefault();
    const cards = [...event.currentTarget.querySelectorAll<HTMLElement>('.catalog-card')];
    const currentIndex = Math.max(0, orderedIds.indexOf(selection.focusId ?? orderedIds[0]!));
    const firstTop = cards[0]?.offsetTop;
    const columns = Math.max(1, cards.filter((card) => card.offsetTop === firstTop).length);
    const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -columns : columns;
    const targetIndex = clamp(currentIndex + delta, 0, orderedIds.length - 1);
    const targetId = orderedIds[targetIndex]!;
    let next: SelectionState;
    if (event.shiftKey) {
      const range = updateSelection(selection, orderedIds, targetId, 'range');
      next = event.metaKey || event.ctrlKey
        ? { ...range, selectedIds: new Set([...selection.selectedIds, ...range.selectedIds]) }
        : range;
    } else if (event.metaKey || event.ctrlKey) {
      next = { ...selection, focusId: targetId };
    } else {
      next = updateSelection(selection, orderedIds, targetId, 'replace');
    }
    setSelection(next);
    props.onSelectedAssetChange(targetId);
    cards[targetIndex]?.focus({ preventScroll: true });
    cards[targetIndex]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const updateRating = async (rating: number) => {
    if (selection.selectedIds.size === 0) return;
    await window.desktopApi.updateCatalogMetadata({ assetIds: [...selection.selectedIds], rating });
    await props.onRefreshCatalog();
  };
  const updateFavorite = async () => {
    if (selection.selectedIds.size === 0) return;
    const allFavorite = [...selection.selectedIds].every((id) => props.availablePhotos.find((photo) => photo.id === id)?.favorite);
    await window.desktopApi.updateCatalogMetadata({ assetIds: [...selection.selectedIds], favorite: !allFavorite });
    await props.onRefreshCatalog();
  };
  const addTags = async () => {
    const names = tagDraft.split(',').map((name) => name.trim()).filter(Boolean);
    if (selection.selectedIds.size === 0 || names.length === 0) return;
    await window.desktopApi.updateCatalogTags({ assetIds: [...selection.selectedIds], addTags: names, removeTagIds: [] });
    setTagDraft('');
    setNotice(`已为 ${selection.selectedIds.size} 张照片添加标签。`);
    await props.onRefreshCatalog();
  };
  const addToAlbum = async () => {
    if (selection.selectedIds.size === 0 || !albumTargetId) return;
    const album = await window.desktopApi.updateCatalogAlbumAssets({ albumId: albumTargetId, assetIds: [...selection.selectedIds], mode: 'add' });
    setNotice(`已加入相册「${album.name}」。`);
    await props.onRefreshCatalog();
  };
  const analyzeSelection = async () => {
    const profile = (await window.desktopApi.listProviderProfiles()).find((item) => item.purpose === 'vision' && item.enabled);
    if (!profile) {
      setNotice('请先在设置中添加并启用视觉分析模型。');
      return;
    }
    await Promise.all([...selection.selectedIds].map((assetId) => window.desktopApi.enqueueTask({ kind: 'analysis', assetId, payload: { providerProfileId: profile.id, mode: 'full' } })));
    setNotice(`已将 ${selection.selectedIds.size} 张照片加入分析队列。`);
  };

  return (
    <div className="catalog-workspace">
      <Sidebar folders={props.catalogFolders} albums={props.catalogAlbums} smartCollections={props.catalogSmartCollections} totalCount={props.totalCount} selectedFolderId={props.selectedFolderId} selectedAlbumId={props.selectedAlbumId} selectedSmartCollection={props.selectedSmartCollection} tags={props.catalogTags} selectedTagId={props.selectedTagId} onSelectFolder={props.onSelectFolder} onSelectAlbum={props.onSelectAlbum} onSelectSmartCollection={props.onSelectSmartCollection} onRefreshAlbums={props.onRefreshAlbums} onImportFolders={props.onImportFolders} onRelinkFolder={props.onRelinkFolder} onUnregisterFolder={props.onUnregisterFolder} onSelectTag={props.onSelectTag} isDemo={props.isDemo} />
      <main className="catalog-main">
        <header className="catalog-toolbar">
          <div className="result-summary"><strong>{collectionTitle(props)}</strong><span>{props.totalCount} 张照片</span></div>
          <div className="catalog-toolbar-actions">
            <label className="sort-control"><select aria-label="图库排序" value={props.sortBy} onChange={(event) => props.onSortByChange(event.target.value as CatalogSort)}><option value="modifiedAt">拍摄时间</option><option value="fileName">文件名</option><option value="rating">评分</option></select><ChevronDown size={12} /></label>
            <button className={`quiet-button${props.favoriteOnly ? ' is-active' : ''}`} type="button" onClick={() => props.onFavoriteOnlyChange(!props.favoriteOnly)}><Star size={13} />仅首选</button>
            <button className="primary-action compact" type="button" disabled={!selectedPhoto} onClick={() => { if (selectedPhoto) props.onOpenViewer(selectedPhoto.id); }}><Image size={14} />打开看图</button>
          </div>
        </header>
        {props.availablePhotos.length === 0 ? (
          <section className="catalog-empty">
            {props.catalogFolders.length === 0 ? <FolderOpen size={34} /> : <Search size={34} />}
            <h2>{props.catalogFolders.length === 0 ? '添加照片文件夹' : props.searchQuery ? '没有匹配的照片' : '此集合为空'}</h2>
            <p>{props.catalogFolders.length === 0 ? '不会复制或修改原图，只建立本地索引。' : '请选择其他目录或调整筛选条件。'}</p>
            {props.catalogFolders.length === 0 && <button className="primary-action compact" type="button" onClick={() => void props.onImportFolders()}><Plus size={14} />选择文件夹</button>}
          </section>
        ) : (
          <section className="catalog-grid" role="listbox" aria-label="图库照片" ref={gridRef} tabIndex={0} onPointerDown={(event) => {
            if (event.button !== 0 || event.target !== event.currentTarget) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            marqueeOriginRef.current = { x: event.clientX, y: event.clientY, additive: event.metaKey || event.ctrlKey || event.shiftKey, initialIds: new Set(selection.selectedIds) };
            setMarquee({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
            if (!(event.metaKey || event.ctrlKey || event.shiftKey)) setSelection({ selectedIds: new Set(), anchorId: null, focusId: null });
          }} onPointerMove={(event) => {
            const origin = marqueeOriginRef.current;
            if (!origin) return;
            const left = Math.min(origin.x, event.clientX);
            const top = Math.min(origin.y, event.clientY);
            const right = Math.max(origin.x, event.clientX);
            const bottom = Math.max(origin.y, event.clientY);
            const hitIds = [...event.currentTarget.querySelectorAll<HTMLElement>('.catalog-card')].filter((card) => {
              const rect = card.getBoundingClientRect();
              return rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top;
            }).map((card) => card.dataset.assetId!).filter(Boolean);
            const selectedIds = new Set(origin.additive ? origin.initialIds : []);
            hitIds.forEach((id) => selectedIds.add(id));
            const focusId = hitIds.at(-1) ?? (origin.additive ? selection.focusId : null);
            setSelection({ selectedIds, anchorId: hitIds[0] ?? (origin.additive ? selection.anchorId : null), focusId });
            if (focusId) props.onSelectedAssetChange(focusId);
            setMarquee({ left, top, width: right - left, height: bottom - top });
          }} onPointerUp={(event) => {
            marqueeOriginRef.current = null;
            setMarquee(null);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }} onPointerCancel={() => { marqueeOriginRef.current = null; setMarquee(null); }} onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
              event.preventDefault();
              setSelection(selectAll(orderedIds));
            }
            if (event.key === 'Enter' && selectedPhoto) props.onOpenViewer(selectedPhoto.id);
            moveGridFocus(event);
          }}>
            {props.availablePhotos.map((photo) => <button className={`catalog-card${selection.selectedIds.has(photo.id) ? ' is-selected' : ''}${selection.focusId === photo.id ? ' is-focused' : ''}${photo.offline ? ' is-offline' : ''}`} type="button" role="option" aria-selected={selection.selectedIds.has(photo.id)} aria-grabbed={selection.selectedIds.has(photo.id)} data-asset-id={photo.id} draggable={selection.selectedIds.has(photo.id)} key={photo.id} onDragStart={(event) => { if (!selection.selectedIds.has(photo.id)) { event.preventDefault(); return; } event.dataTransfer.effectAllowed = 'copyMove'; event.dataTransfer.setData('application/x-photoallisai-assets', JSON.stringify([...selection.selectedIds])); event.dataTransfer.setData('text/plain', `${selection.selectedIds.size} 张照片`); setNotice(`正在拖拽 ${selection.selectedIds.size} 张照片。`); }} onDragEnd={() => setNotice('')} onClick={(event) => selectPhoto(photo, event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'replace')} onDoubleClick={() => props.onOpenViewer(photo.id)}>
              <span className="catalog-card-image"><span className="raw-placeholder"><Image size={25} /><small>{photo.format}</small></span>{photo.thumbnailSrc || photo.src ? <img src={photo.thumbnailSrc ?? photo.src} alt="" /> : null}{selection.selectedIds.has(photo.id) && <span className="selection-check"><Check size={12} /></span>}{photo.offline && <i className="offline-badge">离线</i>}</span>
              <span className="catalog-card-meta"><strong>{photo.fileName}</strong><small>{photo.format} · {photo.dimensions}</small>{photo.rating > 0 && <span aria-label={`${photo.rating} 星`}>{Array.from({ length: photo.rating }, (_, index) => <Star key={index} size={10} fill="currentColor" />)}</span>}</span>
            </button>)}
            {props.hasMore && <button className="catalog-load-more" type="button" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? '加载中…' : '加载更多'}</button>}
            {marquee && <span className="selection-marquee" style={marquee} aria-hidden="true" />}
          </section>
        )}
      </main>
      <aside className="catalog-selection-panel">
        <div><span>当前选择</span><strong>{selection.selectedIds.size} 张照片</strong></div>
        {selectedPhoto ? <><div className="catalog-selection-preview"><img src={selectedPhoto.thumbnailSrc ?? selectedPhoto.src} alt="" /></div><strong className="catalog-selection-name">{selectedPhoto.fileName}</strong><small>{selectedPhoto.format} · {selectedPhoto.dimensions}</small><button className="primary-action" type="button" onClick={() => props.onOpenViewer(selectedPhoto.id)}><Image size={15} />在看图中打开</button><div className="catalog-quick-actions"><span>批量评分</span><div>{[0, 1, 2, 3, 4, 5].map((rating) => <button type="button" key={rating} onClick={() => void updateRating(rating)}>{rating === 0 ? '清除' : rating}</button>)}</div><button className="quiet-button" type="button" onClick={() => void updateFavorite()}><Heart size={13} />切换首选</button><button className="quiet-button" type="button" onClick={() => void analyzeSelection()}><Sparkles size={13} />AI 分析所选</button><form className="catalog-inline-form" onSubmit={(event) => { event.preventDefault(); void addTags(); }}><input aria-label="为所选照片添加标签" value={tagDraft} placeholder="标签，以逗号分隔" onChange={(event) => setTagDraft(event.target.value)} /><button type="submit" disabled={!tagDraft.trim()}>添加</button></form>{props.catalogAlbums.length > 0 && <div className="catalog-inline-form"><select aria-label="将所选照片加入相册" value={albumTargetId} onChange={(event) => setAlbumTargetId(event.target.value)}><option value="">选择相册</option>{props.catalogAlbums.map((album) => <option key={album.id} value={album.id}>{album.name}</option>)}</select><button type="button" disabled={!albumTargetId} onClick={() => void addToAlbum()}>加入</button></div>}</div>{notice && <p className="catalog-notice" role="status">{notice}</p>}</> : <p>选择照片后可批量管理，双击可进入看图。</p>}
      </aside>
      <TaskBar open={false} onToggle={() => undefined} onOpenTaskCenter={props.onOpenTaskCenter} tasks={[]} />
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
  exportPresets,
  isDemo,
  selectedFolderId,
  selectedAlbumId,
  selectedSmartCollection,
  selectedTagId,
  totalCount,
  favoriteOnly,
  onFavoriteOnlyChange,
  sortBy,
  onSortByChange,
  hasMore,
  loadingMore,
  onSelectFolder,
  onSelectAlbum,
  onSelectSmartCollection,
  onRefreshAlbums,
  onImportFolders,
  onRelinkFolder,
  onUnregisterFolder,
  onSelectTag,
  onLoadMore,
  searchQuery,
  selectedAssetId,
  onSelectedAssetChange,
  onRefreshCatalog,
  onOpenTaskCenter,
  onOpenTemplates,
  operationNotice,
  setOperationNotice
}: PopulatedLibraryWorkspaceProps): React.JSX.Element {
  const [viewerLayout, setViewerLayout] = useViewerLayout();
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
  const [generationStorageMode, setGenerationStorageMode] = useState<AppSettings['generationStorageMode']>('managed');
  const [templateItems, setTemplateItems] = useState<PromptTemplate[]>([]);
  const [analysisRevision, setAnalysisRevision] = useState<AnalysisRevision>();
  const [analysisAssetId, setAnalysisAssetId] = useState<string | null>(null);
  const [generationResults, setGenerationResults] = useState<GenerationResult[]>([]);
  const [trashedGenerationResults, setTrashedGenerationResults] = useState<TrashedGenerationResult[]>([]);
  const [generationAssetId, setGenerationAssetId] = useState<string | null>(null);
  const [analysisNotice, setAnalysisNotice] = useState('');
  const [taskItems, setTaskItems] = useState<PersistedTask[]>([]);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [folderAction, setFolderAction] = useState<'move' | 'copy'>('move');
  const [moveTargetFolderId, setMoveTargetFolderId] = useState('');
  const [moveBusy, setMoveBusy] = useState(false);
  const [companionPreview, setCompanionPreview] = useState<CatalogCompanionPreview>({ files: [], totalBytes: 0 });
  const [includeCompanions, setIncludeCompanions] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [batchRenameDialogOpen, setBatchRenameDialogOpen] = useState(false);
  const [batchRenamePrefix, setBatchRenamePrefix] = useState('照片');
  const [removalMode, setRemovalMode] = useState<'remove' | 'trash' | null>(null);
  const [removalBusy, setRemovalBusy] = useState(false);
  const [albumTargetId, setAlbumTargetId] = useState('');
  const [selectedExportPresetId, setSelectedExportPresetId] = useState<string | null>(exportPresets[0]?.id ?? null);
  const [exportSelectionMode, setExportSelectionMode] = useState<ExportSelectionMode>('preferred-or-latest');
  const [trackedExport, setTrackedExport] = useState<{ taskId: string; notice: string; surface: 'viewer' | 'operation' } | null>(null);
  const trackedExportTaskId = trackedExport?.taskId ?? null;
  const trackedExportSurface = trackedExport?.surface ?? null;
  const selected = availablePhotos.find((photo) => photo.id === selectedId) ?? availablePhotos[0]!;
  const currentAnalysisRevision = analysisAssetId === selected.id ? analysisRevision : undefined;
  const currentGenerationResults = generationAssetId === selected.id ? generationResults : [];
  const currentTrashedGenerationResults = generationAssetId === selected.id ? trashedGenerationResults : [];
  const orderedIds = useMemo(() => availablePhotos.map((photo) => photo.id), [availablePhotos]);
  const collectionName = selectedFolderId
    ? catalogFolders.find((folder) => folder.id === selectedFolderId)?.name ?? '文件夹'
    : selectedAlbumId
      ? catalogAlbums.find((album) => album.id === selectedAlbumId)?.name ?? '相册'
      : selectedSmartCollection
        ? selectedSmartCollection === 'recent' ? '最近 30 天' : selectedSmartCollection === 'favorites' ? '首选照片' : selectedSmartCollection === 'unrated' ? '未评分' : selectedSmartCollection === 'unanalyzed' ? '等待 AI 分析' : selectedSmartCollection === 'to-review' ? '待审阅' : '已生成'
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
    if (selectedExportPresetId && exportPresets.some((preset) => preset.id === selectedExportPresetId)) return;
    setSelectedExportPresetId(exportPresets[0]?.id ?? null);
  }, [exportPresets, selectedExportPresetId]);

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
    void Promise.all([window.desktopApi.listProviderProfiles(), window.desktopApi.listPromptTemplates(), window.desktopApi.getAppSettings()]).then(([profiles, savedTemplates, settings]) => {
      setVisionProfiles(profiles.filter((profile) => profile.purpose === 'vision' && profile.enabled));
      setGenerationProfiles(profiles.filter((profile) => profile.purpose === 'generation' && profile.enabled));
      setTemplateItems(savedTemplates);
      setGenerationStorageMode(settings.generationStorageMode);
    });
  }, [isDemo]);

  useEffect(() => {
    if (isDemo || !trackedExportTaskId || !trackedExportSurface) return;
    let active = true;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const task = await window.desktopApi.getTask(trackedExportTaskId);
        if (!active) return;
        if (!task) {
          setTrackedExport((current) => current?.taskId === trackedExportTaskId
            ? { ...current, notice: '无法读取导出任务状态。' }
            : current);
          return;
        }
        let notice: string | null = null;
        const succeeded = typeof task.result?.succeeded === 'number' ? task.result.succeeded : 0;
        const failed = typeof task.result?.failed === 'number' ? task.result.failed : 0;
        if (task.status === 'completed') {
          notice = failed > 0 ? `已导出 ${succeeded} 个文件，${failed} 个失败` : `已导出 ${succeeded} 个文件`;
        } else if (task.status === 'failed') {
          notice = succeeded > 0
            ? `导出部分完成：成功 ${succeeded} 个，失败 ${failed} 个`
            : '导出失败，请检查目录权限和可用空间。';
        } else if (task.status === 'canceled') {
          notice = '导出已取消';
        }
        if (notice) {
          setTrackedExport((current) => current?.taskId === task.id ? { ...current, notice } : current);
          if (trackedExportSurface === 'operation') setOperationNotice(notice);
          return;
        }
        timer = window.setTimeout(refresh, 500);
      } catch {
        if (active) timer = window.setTimeout(refresh, 1_000);
      }
    };
    void refresh();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [isDemo, setOperationNotice, trackedExportSurface, trackedExportTaskId]);

  useEffect(() => {
    if (isDemo) return;
    let active = true;
    const refresh = () => {
      void window.desktopApi.listAnalysisRevisions(selected.id).then((items) => {
        if (active) {
          setAnalysisRevision(items[0]);
          setAnalysisAssetId(selected.id);
        }
      });
    };
    refresh();
    const interval = window.setInterval(refresh, 2_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [isDemo, selected.id]);

  useEffect(() => {
    if (isDemo) return;
    let active = true;
    const refresh = () => {
      void Promise.all([
        window.desktopApi.listGenerationResults(selected.id),
        window.desktopApi.listTrashedGenerationResults(selected.id)
      ]).then(([items, trashedItems]) => {
        if (active) {
          setGenerationResults(items);
          setTrashedGenerationResults(trashedItems);
          setGenerationAssetId(selected.id);
        }
      });
    };
    refresh();
    const interval = window.setInterval(refresh, 1_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [isDemo, selected.id]);

  useEffect(() => {
    if (isDemo) return;
    let active = true;
    const refresh = () => {
      void window.desktopApi.listTaskPage({ limit: 20, cursor: null }).then((page) => {
        if (active) setTaskItems(page.items);
      });
    };
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

  const favoriteSelection = async (favorite: boolean) => {
    if (isDemo) return;
    const assetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
    await window.desktopApi.updateCatalogMetadata({ assetIds, favorite });
    setOperationNotice(favorite ? `已收藏 ${assetIds.length} 张照片。` : `已取消收藏 ${assetIds.length} 张照片。`);
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
      const revisions = assetId === selected.id && currentAnalysisRevision
        ? [currentAnalysisRevision]
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
        templateBody: template?.body ?? DEFAULT_GENERATION_TEMPLATE_BODY,
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
            resultIndex,
            storageMode: generationStorageMode,
            analysisRevisionId: revision.id,
            disabledActionIds: revision.result.generativeActions
              .filter((action) => action.enabled && !analysis.generativeActions.find((item) => item.id === action.id)?.enabled)
              .map((action) => action.id),
            userInstruction: instruction
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

  const exportResults = async (
    resultIds: string[],
    presetId = selectedExportPresetId,
    surface: 'viewer' | 'operation' = 'viewer'
  ): Promise<string> => {
    try {
      const task = await window.desktopApi.exportGenerationResults({ resultIds, presetId });
      if (!task) return '已取消导出';
      setTasksOpen(true);
      const notice = `已将 ${resultIds.length} 个文件加入导出队列`;
      setTrackedExport({ taskId: task.id, notice, surface });
      return notice;
    } catch {
      return '导出失败，请检查目录权限和可用空间。';
    }
  };

  const exportLatestSelection = async () => {
    const targetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
    const lists = await Promise.all(targetIds.map((assetId) =>
      assetId === selected.id ? Promise.resolve(currentGenerationResults) : window.desktopApi.listGenerationResults(assetId)
    ));
    const resultIds = lists.flatMap((items) => pickExportResults(items, exportSelectionMode).map((result) => result.id));
    if (resultIds.length === 0) {
      setOperationNotice('所选照片还没有可导出的生成版本。');
      return;
    }
    setOperationNotice(await exportResults(resultIds, selectedExportPresetId, 'operation'));
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
        resultIndex: 1,
        storageMode: result.storageMode
      }
    });
    setTasksOpen(true);
    return '已按当前方案加入 1 个生成任务。';
  };

  const reviewResult = async (resultId: string, reviewState: GenerationResult['reviewState']): Promise<void> => {
    try {
      const updated = await window.desktopApi.updateGenerationResultReview({ resultId, reviewState });
      setGenerationResults((current) => current.map((result) => {
        if (result.id === updated.id) return updated;
        if (reviewState === 'preferred' && result.reviewState === 'preferred') return { ...result, reviewState: 'accepted' };
        return result;
      }));
      setOperationNotice(reviewState === 'preferred' ? '已标记为首选版本。' : reviewState === 'accepted' ? '已接受当前版本。' : '已拒绝当前版本。');
    } catch {
      setOperationNotice('版本状态更新失败，请稍后重试。');
    }
  };

  const reloadGenerationResults = async (): Promise<void> => {
    const [items, trashedItems] = await Promise.all([
      window.desktopApi.listGenerationResults(selected.id),
      window.desktopApi.listTrashedGenerationResults(selected.id)
    ]);
    setGenerationResults(items);
    setTrashedGenerationResults(trashedItems);
  };

  const trashGenerationResult = async (resultId: string): Promise<void> => {
    try {
      await window.desktopApi.trashGenerationResult({ resultId });
      await reloadGenerationResults();
      setOperationNotice('生成版本已移到应用回收站，原图未受影响。');
      await onRefreshCatalog();
    } catch {
      setOperationNotice('无法回收生成版本，请确认文件仍可访问。');
      throw new Error('GENERATION_RESULT_TRASH_FAILED');
    }
  };

  const restoreGenerationResult = async (resultId: string): Promise<void> => {
    try {
      await window.desktopApi.restoreGenerationResult({ resultId });
      await reloadGenerationResults();
      setOperationNotice('生成版本已恢复。');
      await onRefreshCatalog();
    } catch {
      setOperationNotice('无法恢复生成版本：目标位置可能已有同名文件。');
      throw new Error('GENERATION_RESULT_RESTORE_FAILED');
    }
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

  const openFolderDialog = async (action: 'move' | 'copy') => {
    const firstTarget = catalogFolders.find((folder) => folder.id !== selected.folderId);
    const assetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
    setFolderAction(action);
    setMoveTargetFolderId(firstTarget?.id ?? catalogFolders[0]?.id ?? '');
    setIncludeCompanions(false);
    try {
      setCompanionPreview(await window.desktopApi.previewCatalogCompanions(assetIds));
    } catch {
      setCompanionPreview({ files: [], totalBytes: 0 });
    }
    setMoveDialogOpen(true);
  };

  const executeFolderOperation = async () => {
    if (!moveTargetFolderId || moveBusy) return;
    const assetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
    setMoveBusy(true);
    try {
      const report = folderAction === 'move'
        ? await window.desktopApi.moveCatalogAssets({ assetIds, targetFolderId: moveTargetFolderId, includeCompanions })
        : await window.desktopApi.copyCatalogAssets({ assetIds, targetFolderId: moveTargetFolderId, includeCompanions });
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

  const renameBatch = async () => {
    if (!batchRenamePrefix.trim() || renameBusy) return;
    const items = [...selection.selectedIds].map((assetId, index) => {
      const photo = availablePhotos.find((item) => item.id === assetId);
      const extension = photo?.fileName.match(/\.[^.]+$/)?.[0] ?? '';
      return { assetId, fileName: `${batchRenamePrefix.trim()}_${String(index + 1).padStart(3, '0')}${extension}` };
    });
    if (items.length < 2) return;
    setRenameBusy(true);
    try {
      const report = await window.desktopApi.renameCatalogAssets({ items });
      setOperationNotice(`批量重命名完成 ${report.succeeded} 张，失败 ${report.failed} 张。`);
      setBatchRenameDialogOpen(false);
      await onRefreshCatalog();
    } catch {
      setOperationNotice('批量重命名失败，请检查文件名和权限。');
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

  useLayoutEffect(() => {
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
    <div className="workspace viewer-workspace" style={{ gridTemplateColumns: `${viewerLayout.leftWidth}px 5px minmax(0, 1fr) 5px ${viewerLayout.rightWidth}px` }}>
      <Sidebar folders={catalogFolders} albums={catalogAlbums} smartCollections={catalogSmartCollections} totalCount={totalCount} selectedFolderId={selectedFolderId} selectedAlbumId={selectedAlbumId} selectedSmartCollection={selectedSmartCollection} tags={catalogTags} selectedTagId={selectedTagId} onSelectFolder={onSelectFolder} onSelectAlbum={onSelectAlbum} onSelectSmartCollection={onSelectSmartCollection} onRefreshAlbums={onRefreshAlbums} onImportFolders={onImportFolders} onRelinkFolder={onRelinkFolder} onUnregisterFolder={onUnregisterFolder} onSelectTag={onSelectTag} isDemo={isDemo} />
      <PaneSplitter orientation="vertical" value={viewerLayout.leftWidth} minimum={160} maximum={420} label="调整左侧目录栏宽度" onChange={(value) => setViewerLayout('leftWidth', value)} />
      <main className="library-main" style={{ gridTemplateRows: `minmax(0, 1fr) 5px ${viewerLayout.filmstripHeight}px` }}>
        <Viewer photo={selected} results={currentGenerationResults} isDemo={isDemo} exportPresets={exportPresets} selectedExportPresetId={selectedExportPresetId} trackedExportNotice={trackedExport?.surface === 'viewer' ? trackedExport.notice : ''} onExportPresetChange={setSelectedExportPresetId} onExport={exportResults} onRate={(rating) => void rateSelection(rating)} onFavorite={(favorite) => void favoriteSelection(favorite)} onRegenerate={regenerate} onEditTags={() => setTagEditorOpen(true)} onMove={() => openFolderDialog('move')} onCopy={() => openFolderDialog('copy')} onRename={openRenameDialog} onRemove={() => setRemovalMode('remove')} onTrash={() => setRemovalMode('trash')} onReview={reviewResult} onRevealOriginal={() => void window.desktopApi.revealCatalogAsset(selected.id)} onRevealResult={(resultId) => void window.desktopApi.revealGenerationResult(resultId)} />
        <PaneSplitter orientation="horizontal" value={viewerLayout.filmstripHeight} minimum={110} maximum={320} label="调整大图和胶片带高度" invert onChange={(value) => setViewerLayout('filmstripHeight', value)} />
        <Filmstrip items={availablePhotos} selected={selected} selection={selection} onSelect={selectPhoto} collectionName={collectionName} totalCount={totalCount} favoriteOnly={favoriteOnly} onFavoriteOnlyChange={onFavoriteOnlyChange} sortBy={sortBy} onSortByChange={onSortByChange} hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} />
      </main>
      <PaneSplitter orientation="vertical" value={viewerLayout.rightWidth} minimum={240} maximum={520} label="调整右侧 AI 面板宽度" invert onChange={(value) => setViewerLayout('rightWidth', value)} />
      <AiPanel photo={selected} results={currentGenerationResults} trashedResults={currentTrashedGenerationResults} revision={currentAnalysisRevision} isDemo={isDemo} notice={analysisNotice} onAnalyze={() => void analyzeSelection()} generationProfiles={generationProfiles} templates={templateItems} onOpenTemplates={onOpenTemplates} onGenerate={generateSelection} onTrashResult={trashGenerationResult} onRestoreResult={restoreGenerationResult} />
      {selection.selectedIds.size > 1 && (
        <div className="batch-actionbar">
          <strong>已选择 {selection.selectedIds.size} 张</strong>
          <div className="batch-actions-scroll">
            <button type="button" onClick={() => void rateSelection(5)}><Star size={14} />5 星</button>
            <button type="button" onClick={() => void favoriteSelection(![...selection.selectedIds].every((id) => availablePhotos.find((photo) => photo.id === id)?.favorite))}><Heart size={14} />{[...selection.selectedIds].every((id) => availablePhotos.find((photo) => photo.id === id)?.favorite) ? '取消收藏' : '收藏'}</button>
            <button type="button" onClick={() => setTagEditorOpen(true)}><Tags size={14} />标签</button>
            {!isDemo && <><button type="button" onClick={() => openFolderDialog('copy')}><Copy size={14} />复制</button><button type="button" onClick={() => openFolderDialog('move')}><FolderInput size={14} />移动</button></>}
            <button type="button" onClick={() => void analyzeSelection()}><Sparkles size={14} />AI 分析</button>
            <button type="button" onClick={() => void generateSelection({ providerProfileId: generationProfiles[0]?.id ?? '', template: null, count: 1, instruction: '', disabledActionIds: new Set() })} disabled={generationProfiles.length === 0}><WandSparkles size={14} />批量生成</button>
            <select aria-label="批量导出版本" value={exportSelectionMode} onChange={(event) => setExportSelectionMode(event.target.value as ExportSelectionMode)}><option value="preferred-or-latest">每张首选 / 最新</option><option value="accepted">所有已接受</option><option value="all">所有版本</option></select><select aria-label="导出预设" value={selectedExportPresetId ?? ''} onChange={(event) => setSelectedExportPresetId(event.target.value || null)}><option value="">默认命名</option>{exportPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select><button type="button" onClick={() => void exportLatestSelection()}><Download size={14} />导出</button>
            {!isDemo && <button type="button" onClick={() => setBatchRenameDialogOpen(true)}><FilePenLine size={14} />批量重命名</button>}
            {!isDemo && catalogAlbums.length > 0 && <><select aria-label="目标相册" value={albumTargetId} onChange={(event) => setAlbumTargetId(event.target.value)}><option value="">相册</option>{catalogAlbums.map((album) => <option key={album.id} value={album.id}>{album.name}</option>)}</select><button type="button" disabled={!albumTargetId} onClick={() => void updateAlbumMembership('add')}><FolderHeart size={14} />加入</button>{selectedAlbumId && <button type="button" onClick={() => void updateAlbumMembership('remove')}><FolderHeart size={14} />移出</button>}</>}
            {!isDemo && <><button type="button" onClick={() => setRemovalMode('remove')}><LibraryBig size={14} />移除</button><button className="is-danger" type="button" onClick={() => setRemovalMode('trash')}><Trash2 size={14} />回收站</button></>}
          </div>
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
            {companionPreview.files.length > 0 && <label className="companion-choice"><input type="checkbox" checked={includeCompanions} onChange={(event) => setIncludeCompanions(event.target.checked)} /><span><strong>同时处理 {companionPreview.files.length} 个关联文件</strong><small>{companionPreview.files.map((file) => file.fileName).join('、')} · {(companionPreview.totalBytes / 1_048_576).toFixed(1)} MB</small></span></label>}
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
      {batchRenameDialogOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !renameBusy) setBatchRenameDialogOpen(false); }}><form className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-rename-dialog-title" onSubmit={(event) => { event.preventDefault(); void renameBatch(); }}><header><div><span className="dialog-icon"><FilePenLine size={16} /></span><div><h2 id="batch-rename-dialog-title">批量重命名</h2><p>将按选择顺序生成序号，原扩展名保持不变。</p></div></div><IconButton label="关闭批量重命名窗口" disabled={renameBusy} onClick={() => setBatchRenameDialogOpen(false)}><X size={15} /></IconButton></header><label className="rename-field"><span>名称前缀</span><input autoFocus aria-label="批量重命名前缀" value={batchRenamePrefix} onChange={(event) => setBatchRenamePrefix(event.target.value)} /></label><footer><span>共 {selection.selectedIds.size} 张 · 示例：{batchRenamePrefix || '照片'}_001</span><div><button className="quiet-button" type="button" disabled={renameBusy} onClick={() => setBatchRenameDialogOpen(false)}>取消</button><button className="primary-action compact" type="submit" disabled={selection.selectedIds.size < 2 || !batchRenamePrefix.trim() || renameBusy}>{renameBusy ? '正在重命名…' : '开始重命名'}</button></div></footer></form></div>}
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
      <TaskBar open={tasksOpen} onToggle={() => setTasksOpen((value) => !value)} onOpenTaskCenter={onOpenTaskCenter} tasks={isDemo ? null : taskItems} />
    </div>
  );
}

const emptyProviderForm: SaveProviderProfileInput = {
  name: '',
  kind: 'openai-compatible',
  purpose: 'vision',
  baseUrl: '',
  modelId: '',
  requestTimeoutMs: 300_000,
  retryCount: 2,
  customHeaders: {},
  apiKey: '',
  enabled: true
};

function SettingsPage({ onExportPresetsChange }: { onExportPresetsChange: (presets: ExportPreset[]) => void }): React.JSX.Element {
  type SettingsSection = 'appearance' | 'models' | 'storage' | 'tasks' | 'shortcuts' | 'privacy';
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('models');
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [form, setForm] = useState<SaveProviderProfileInput>(emptyProviderForm);
  const [customHeadersText, setCustomHeadersText] = useState('{}');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [providerDeleteCandidate, setProviderDeleteCandidate] = useState<string | null>(null);
  const [presets, setPresets] = useState<ExportPreset[]>([]);
  const [presetName, setPresetName] = useState('');
  const [presetFormat, setPresetFormat] = useState<ExportPreset['format']>('jpeg');
  const [presetQuality, setPresetQuality] = useState(90);
  const [presetMaxDimension, setPresetMaxDimension] = useState<number | null>(null);
  const [presetMessage, setPresetMessage] = useState('');
  const [cacheStats, setCacheStats] = useState<ImageCacheStats | null>(null);
  const [cacheMessage, setCacheMessage] = useState('');
  const [cacheBusy, setCacheBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticSnapshot | null>(null);
  const [diagnosticMessage, setDiagnosticMessage] = useState('');
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [integrityBusy, setIntegrityBusy] = useState(false);
  const [generationStorageMode, setGenerationStorageMode] = useState<AppSettings['generationStorageMode']>('managed');
  const [theme, setTheme] = useState<AppSettings['theme']>('system');
  const [cacheMaxBytes, setCacheMaxBytes] = useState(5 * 1024 ** 3);
  const [storageMessage, setStorageMessage] = useState('');
  const [storageBusy, setStorageBusy] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMessage, setBackupMessage] = useState('');
  const [libraryBackupBusy, setLibraryBackupBusy] = useState(false);
  const [backupVerifyBusy, setBackupVerifyBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [trashSummary, setTrashSummary] = useState<GenerationTrashSummary | null>(null);
  const [trashMessage, setTrashMessage] = useState('');
  const [trashBusy, setTrashBusy] = useState(false);
  const [trashConfirmationOpen, setTrashConfirmationOpen] = useState(false);

  useEffect(() => {
    void window.desktopApi.listProviderProfiles().then(setProfiles);
    void window.desktopApi.listExportPresets().then((items) => {
      setPresets(items);
      onExportPresetsChange(items);
    });
    void window.desktopApi.getImageCacheStats().then(setCacheStats);
    void window.desktopApi.getGenerationTrashSummary().then(setTrashSummary);
    void window.desktopApi.getDiagnosticSnapshot().then(setDiagnostics);
    void window.desktopApi.getAppSettings().then((settings) => {
      setGenerationStorageMode(settings.generationStorageMode);
      setTheme(settings.theme);
      setCacheMaxBytes(settings.cacheMaxBytes);
    });
  }, [onExportPresetsChange]);

  const saveStorageMode = async (value: AppSettings['generationStorageMode']) => {
    setGenerationStorageMode(value);
    setStorageBusy(true);
    setStorageMessage('');
    try {
      const saved = await window.desktopApi.saveAppSettings({ generationStorageMode: value, theme, cacheMaxBytes });
      setGenerationStorageMode(saved.generationStorageMode);
      setStorageMessage('存储策略已保存，新加入队列的任务将使用该策略。');
    } catch {
      setStorageMessage('存储策略保存失败，请检查应用权限。');
    } finally {
      setStorageBusy(false);
    }
  };

  const saveTheme = async (value: AppSettings['theme']) => {
    setTheme(value);
    try {
      const saved = await window.desktopApi.saveAppSettings({ generationStorageMode, theme: value, cacheMaxBytes });
      setTheme(saved.theme);
      applyTheme(saved.theme);
      window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: saved.theme }));
    } catch {
      setMessage('主题设置保存失败，请检查应用权限。');
    }
  };

  const saveCacheMaxBytes = async (value: number) => {
    setCacheMaxBytes(value);
    setCacheBusy(true);
    setCacheMessage('');
    try {
      const saved = await window.desktopApi.saveAppSettings({ generationStorageMode, theme, cacheMaxBytes: value });
      setCacheMaxBytes(saved.cacheMaxBytes);
      setCacheStats(await window.desktopApi.getImageCacheStats());
      setCacheMessage('缓存上限已保存，超出部分已按最近使用时间清理。');
    } catch {
      setCacheMessage('缓存上限保存失败，请检查应用权限。');
    } finally {
      setCacheBusy(false);
    }
  };

  const patchForm = <Key extends keyof SaveProviderProfileInput>(key: Key, value: SaveProviderProfileInput[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setMessage('');
    setProviderDeleteCandidate(null);
  };

  const deleteProvider = async () => {
    if (!form.id) return;
    if (providerDeleteCandidate !== form.id) {
      setProviderDeleteCandidate(form.id);
      setMessage('再次点击确认删除；有运行中任务时无法删除。');
      return;
    }
    setBusy('save');
    try {
      await window.desktopApi.deleteProviderProfile(form.id);
      setProfiles((current) => current.filter((profile) => profile.id !== form.id));
      setForm(emptyProviderForm);
      setCustomHeadersText('{}');
      setProviderDeleteCandidate(null);
      setMessage('模型配置及其本地凭据已删除。');
    } catch {
      setMessage('删除失败，请先取消使用此配置的运行中任务。');
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    try {
      const customHeaders = JSON.parse(customHeadersText) as SaveProviderProfileInput['customHeaders'];
      const saved = await window.desktopApi.saveProviderProfile({ ...form, customHeaders });
      setProfiles((current) => [...current.filter((profile) => profile.id !== saved.id), saved]);
      setForm(emptyProviderForm);
      setCustomHeadersText('{}');
      setMessage('配置已安全保存');
    } catch (error) {
      setMessage(error instanceof SyntaxError ? '自定义请求头必须是有效的 JSON 对象' : '保存失败，请检查必填项、服务地址和自定义请求头');
    } finally {
      setBusy(null);
    }
  };

  const testConnection = async () => {
    setBusy('test');
    try {
      const customHeaders = JSON.parse(customHeadersText) as SaveProviderProfileInput['customHeaders'];
      const result = await window.desktopApi.testProviderConnection({ ...form, customHeaders });
      setMessage(`${result.message}${result.latencyMs > 0 ? ` · ${result.latencyMs} ms` : ''}`);
    } catch (error) {
      setMessage(error instanceof SyntaxError ? '自定义请求头必须是有效的 JSON 对象' : '连接测试失败，请检查配置和自定义请求头');
    } finally {
      setBusy(null);
    }
  };

  const copyDiagnostics = async () => {
    if (!diagnostics) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      setDiagnosticMessage('诊断摘要已复制，可直接粘贴给支持团队。');
    } catch {
      setDiagnosticMessage('复制失败，请检查系统剪贴板权限。');
    }
  };
  const exportDiagnostics = async () => {
    setDiagnosticBusy(true);
    try {
      const result = await window.desktopApi.exportDiagnosticSnapshot();
      setDiagnosticMessage(result.canceled ? '已取消诊断文件导出。' : `诊断文件已保存（${result.bytes.toLocaleString()} 字节）。`);
    } catch {
      setDiagnosticMessage('诊断文件导出失败，请检查目标目录权限。');
    } finally {
      setDiagnosticBusy(false);
    }
  };
  const runIntegrityCheck = async () => {
    setIntegrityBusy(true);
    setDiagnosticMessage('');
    try {
      const integrity = await window.desktopApi.runLibraryIntegrityCheck();
      setDiagnostics((current) => current ? { ...current, integrity } : current);
      setDiagnosticMessage(integrity.status === 'healthy' ? '图库完整性检查通过。' : integrity.status === 'warning' ? '检查完成：发现可清理的孤立或回收内容。' : '检查完成：发现需要处理的存储错误。');
    } catch {
      setDiagnosticMessage('图库完整性检查失败，请确认图库磁盘仍可访问。');
    } finally {
      setIntegrityBusy(false);
    }
  };

  const backupDatabase = async () => {
    setBackupBusy(true);
    setBackupMessage('');
    try {
      const result = await window.desktopApi.backupDatabase();
      setBackupMessage(result.canceled ? '已取消数据库备份。' : `数据库快照已保存（${(result.bytes / 1_048_576).toFixed(1)} MB）。`);
    } catch {
      setBackupMessage('数据库备份失败，请确认目标目录可写且磁盘空间充足。');
    } finally {
      setBackupBusy(false);
    }
  };
  const backupCompleteLibrary = async () => {
    setLibraryBackupBusy(true);
    setBackupMessage('');
    try {
      const result = await window.desktopApi.backupLibrary();
      setBackupMessage(result.canceled
        ? '已取消完整图库备份。'
        : `完整图库已备份：数据库 ${(result.databaseBytes / 1_048_576).toFixed(1)} MB，受管结果 ${result.generatedFiles} 个（${(result.generatedBytes / 1_048_576).toFixed(1)} MB）。`);
    } catch {
      setBackupMessage('完整图库备份失败；请确认目标在图库外、空间充足，且受管结果文件完整。');
    } finally {
      setLibraryBackupBusy(false);
    }
  };
  const verifyCompleteLibraryBackup = async () => {
    setBackupVerifyBusy(true);
    setBackupMessage('');
    try {
      const result = await window.desktopApi.verifyLibraryBackup();
      setBackupMessage(result.canceled
        ? '已取消备份验证。'
        : `备份验证通过：数据库 ${(result.databaseBytes / 1_048_576).toFixed(1)} MB，受管结果 ${result.generatedFiles} 个（${(result.generatedBytes / 1_048_576).toFixed(1)} MB）。`);
    } catch {
      setBackupMessage('备份验证失败；清单、数据库或受管结果可能缺失、损坏或互不一致。');
    } finally {
      setBackupVerifyBusy(false);
    }
  };
  const restoreCompleteLibraryBackup = async () => {
    setRestoreBusy(true);
    setBackupMessage('');
    try {
      const result = await window.desktopApi.restoreLibraryBackup();
      setBackupMessage(result.canceled
        ? '已取消图库恢复。'
        : `备份验证并暂存完成：数据库 ${(result.databaseBytes / 1_048_576).toFixed(1)} MB，受管结果 ${result.generatedFiles} 个。应用即将重启。`);
    } catch {
      setBackupMessage('图库恢复未启动；备份包可能损坏、空间不足，或已有恢复正在等待重启。');
    } finally {
      setRestoreBusy(false);
    }
  };

  const emptyGenerationTrash = async () => {
    setTrashBusy(true);
    setTrashMessage('');
    try {
      const report = await window.desktopApi.emptyGenerationTrash();
      setTrashSummary(await window.desktopApi.getGenerationTrashSummary());
      setTrashConfirmationOpen(false);
      setTrashMessage(report.failed > 0
        ? `已永久清理 ${report.purged} 个版本，${report.failed} 个因路径或文件异常而保留。`
        : `已永久清理 ${report.purged} 个版本，释放 ${formatStorageBytes(report.freedBytes)}。`);
    } catch {
      setTrashMessage('回收站清理失败，未完成的版本仍保留，可稍后重试。');
    } finally {
      setTrashBusy(false);
    }
  };

  return (
    <div className="settings-page">
      <aside className="settings-nav">
        <strong>设置</strong>
        <button className={settingsSection === 'appearance' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('appearance')} aria-current={settingsSection === 'appearance' ? 'page' : undefined}><SunMoon size={14} />外观</button>
        <button className={settingsSection === 'models' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('models')} aria-current={settingsSection === 'models' ? 'page' : undefined}><Bot size={14} />AI 模型</button>
        <button className={settingsSection === 'storage' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('storage')} aria-current={settingsSection === 'storage' ? 'page' : undefined}><Folder size={14} />图库与存储</button>
        <button className={settingsSection === 'tasks' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('tasks')} aria-current={settingsSection === 'tasks' ? 'page' : undefined}><Clock3 size={14} />任务与重试</button>
        <button className={settingsSection === 'shortcuts' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('shortcuts')} aria-current={settingsSection === 'shortcuts' ? 'page' : undefined}><Command size={14} />快捷键</button>
        <button className={settingsSection === 'privacy' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('privacy')} aria-current={settingsSection === 'privacy' ? 'page' : undefined}><ShieldCheck size={14} />隐私与安全</button>
      </aside>
      <main className="settings-content">
        <div className="settings-heading">
          <div><h1>{settingsSection === 'appearance' ? '外观' : settingsSection === 'models' ? 'AI 模型' : settingsSection === 'storage' ? '图库与存储' : settingsSection === 'tasks' ? '任务与重试' : settingsSection === 'shortcuts' ? '快捷键' : '隐私与安全'}</h1><p>{settingsSection === 'appearance' ? '选择适合当前环境的工作台表面，照片画布保持中性。' : settingsSection === 'models' ? '配置用于视觉分析与图片生成的兼容服务。应用不会提供默认密钥。' : settingsSection === 'storage' ? '管理预览缓存与生成结果的保存位置。' : settingsSection === 'tasks' ? '控制后台队列的执行节奏和失败恢复行为。' : settingsSection === 'shortcuts' ? '查看常用图库和任务操作的键盘入口。' : '了解图片上传、凭据和诊断数据的处理边界。'}</p></div>
          <span><ShieldCheck size={14} />本地优先</span>
        </div>

        {settingsSection === 'appearance' && <section className="settings-section storage-section"><div className="settings-heading"><div><h2>界面主题</h2><p>跟随系统会在系统外观变化时即时切换，不需要重启应用。</p></div><span><SunMoon size={14} />照片优先</span></div><div className="storage-options" aria-label="界面主题">{([['system', '跟随系统', '自动使用 macOS 或 Windows 当前外观。'], ['dark', '深色', '适合暗光环境和长时间看图。'], ['light', '浅色', '适合明亮环境和文档型工作流。']] as const).map(([value, label, description]) => <label className={theme === value ? 'is-selected' : ''} key={value}><input type="radio" name="theme" checked={theme === value} onChange={() => void saveTheme(value)} /><span><strong>{label}</strong><small>{description}</small></span><Check size={15} /></label>)}</div></section>}
        {settingsSection === 'models' && <>
        <section className="provider-layout">
          <div className="provider-list">
            <div className="provider-list-head"><strong>已配置服务</strong><span>{profiles.length}</span></div>
            {profiles.length === 0 ? (
              <div className="provider-empty"><Server size={25} /><strong>尚未配置模型</strong><span>填写右侧表单开始使用 AI 功能</span></div>
            ) : profiles.map((profile) => (
              <button className="provider-item" key={profile.id} type="button" onClick={() => { setForm({
                id: profile.id,
                name: profile.name,
                kind: profile.kind,
                purpose: profile.purpose,
                baseUrl: profile.baseUrl,
                modelId: profile.modelId,
                requestTimeoutMs: profile.requestTimeoutMs,
                retryCount: profile.retryCount,
                customHeaders: profile.customHeaders,
                enabled: profile.enabled
              }); setCustomHeadersText(JSON.stringify(profile.customHeaders, null, 2)); setProviderDeleteCandidate(null); }}>
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
            <div className="form-grid two-columns">
              <label><span>请求超时</span><select aria-label="模型请求超时" value={form.requestTimeoutMs} onChange={(event) => patchForm('requestTimeoutMs', Number(event.target.value))}><option value={30_000}>30 秒</option><option value={60_000}>60 秒</option><option value={120_000}>2 分钟</option><option value={300_000}>5 分钟</option><option value={600_000}>10 分钟</option></select></label>
              <label><span>自动重试</span><select aria-label="模型自动重试次数" value={form.retryCount} onChange={(event) => patchForm('retryCount', Number(event.target.value))}><option value={0}>不重试</option><option value={1}>1 次</option><option value={2}>2 次</option><option value={3}>3 次</option><option value={5}>5 次</option></select><small>仅针对限流、网关和服务暂不可用；取消任务会中断等待。</small></label>
            </div>
            <label><span>自定义请求头</span><textarea aria-label="模型自定义请求头" rows={4} spellCheck={false} value={customHeadersText} onChange={(event) => { setCustomHeadersText(event.target.value); setMessage(''); }} /><small>使用 JSON 对象；认证、Cookie、Host、来源及传输层请求头不可覆盖。敏感凭据请只填写 API Key。</small></label>
            <label><span>API Key</span><div className="secret-input"><KeyRound size={14} /><input type="password" autoComplete="off" placeholder={form.id ? '留空以保留已保存凭据' : '输入服务密钥'} value={form.apiKey ?? ''} onChange={(event) => patchForm('apiKey', event.target.value)} /></div><small>密钥不会写入图库数据库、日志或导出清单。</small></label>
            <label className="enabled-row"><input type="checkbox" checked={form.enabled} onChange={(event) => patchForm('enabled', event.target.checked)} /><span>启用此配置</span></label>
            <div className="form-feedback" role="status">{message}</div>
            <div className="form-actions">{form.id && <button className="danger-action compact" type="button" disabled={busy !== null} onClick={() => void deleteProvider()}>{providerDeleteCandidate === form.id ? '确认删除' : '删除配置'}</button>}<button className="secondary-action" type="button" disabled={busy !== null} onClick={() => void testConnection()}>{busy === 'test' ? '测试中…' : '测试连接'}</button><button className="primary-action compact" type="submit" disabled={busy !== null}>{busy === 'save' ? '保存中…' : '保存配置'}</button></div>
          </form>
        </section>
        <section className="settings-section export-presets-section">
          <div className="settings-heading"><div><h2>导出预设</h2><p>保存格式、尺寸、JPEG 质量和命名策略；原格式导出不会重新编码。</p></div><span><Download size={14} />受管结果可随时导出</span></div>
          <div className="preset-row"><input aria-label="导出预设名称" placeholder="例如：客户交付" value={presetName} onChange={(event) => { setPresetName(event.target.value); setPresetMessage(''); }} /><select aria-label="导出格式" value={presetFormat} onChange={(event) => setPresetFormat(event.target.value as ExportPreset['format'])}><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="original">原格式</option></select><input aria-label="JPEG 质量" type="number" min="1" max="100" disabled={presetFormat !== 'jpeg'} value={presetQuality} onChange={(event) => setPresetQuality(Number(event.target.value))} /><select aria-label="导出尺寸" value={presetMaxDimension ?? ''} onChange={(event) => setPresetMaxDimension(event.target.value ? Number(event.target.value) : null)}><option value="">原始尺寸</option><option value="2048">长边 2048px</option><option value="3840">长边 3840px</option><option value="6000">长边 6000px</option></select><button className="primary-action compact" type="button" disabled={!presetName.trim()} onClick={async () => { try { const saved = await window.desktopApi.saveExportPreset({ name: presetName.trim(), format: presetFormat, quality: presetQuality, maxDimension: presetMaxDimension, conflictPolicy: 'auto-rename', namingPattern: '{name}_{version}' }); setPresets((current) => { const next = [...current.filter((item) => item.id !== saved.id), saved]; onExportPresetsChange(next); return next; }); setPresetName(''); setPresetMessage('预设已保存'); } catch { setPresetMessage('名称已存在或保存失败'); } }}>保存预设</button></div>
          <div className="preset-list">{presets.length === 0 ? <small>暂无导出预设</small> : presets.map((preset) => <div className="preset-item" key={preset.id}><span><strong>{preset.name}</strong><small>{preset.format === 'original' ? '原格式' : preset.format.toUpperCase()}{preset.format === 'jpeg' ? ` · 质量 ${preset.quality}` : ''}{preset.maxDimension ? ` · 长边 ${preset.maxDimension}px` : ''} · {preset.conflictPolicy === 'skip' ? '跳过同名' : '自动编号'}</small></span><button type="button" aria-label={`删除导出预设 ${preset.name}`} onClick={async () => { await window.desktopApi.deleteExportPreset(preset.id); setPresets((current) => { const next = current.filter((item) => item.id !== preset.id); onExportPresetsChange(next); return next; }); }}>删除</button></div>)}</div>
          {presetMessage && <div className="form-feedback" role="status">{presetMessage}</div>}
        </section>
        </>}
        {settingsSection === 'storage' && <>
        <section className="settings-section storage-section">
          <div className="settings-heading"><div><h2>生成结果存储</h2><p>原图始终保持不变。策略会写入每个任务，重试和导出时可追溯。</p></div><span><Folder size={14} />不会覆盖原图</span></div>
          <div className="storage-options" aria-label="生成结果存储策略">
            <label className={generationStorageMode === 'managed' ? 'is-selected' : ''}><input type="radio" name="generation-storage" checked={generationStorageMode === 'managed'} disabled={storageBusy} onChange={() => void saveStorageMode('managed')} /><span><strong>集中受管（默认）</strong><small>保存到应用图库的 generated 目录，适合统一管理和批量导出。</small></span><Check size={15} /></label>
            <label className={generationStorageMode === 'portable' ? 'is-selected' : ''}><input type="radio" name="generation-storage" checked={generationStorageMode === 'portable'} disabled={storageBusy} onChange={() => void saveStorageMode('portable')} /><span><strong>原图旁便携目录</strong><small>在原图目录创建 _PhotoAllIsAI，不扫描回图库，也不会自动回退。</small></span><Check size={15} /></label>
          </div>
          <div className="form-feedback" role="status">{storageMessage || '便携模式需要原图目录具有写入权限；失败时任务会明确报错。'}</div>
        </section>
        <section className="settings-section cache-section">
          <div className="settings-heading"><div><h2>预览缓存</h2><p>缓存可安全重建，不会删除原图、生成结果或分析数据。</p></div><span>{cacheStats ? `${cacheStats.files} 个文件 · ${(cacheStats.bytes / 1_073_741_824).toFixed(2)} GiB` : '正在读取'}</span></div>
          <label className="cache-limit"><span><strong>磁盘上限</strong><small>达到上限后优先清理最久未使用的缩略图和屏幕预览。</small></span><select aria-label="预览缓存磁盘上限" value={cacheMaxBytes} disabled={cacheBusy} onChange={(event) => void saveCacheMaxBytes(Number(event.target.value))}><option value={1024 ** 3}>1 GiB</option><option value={5 * 1024 ** 3}>5 GiB</option><option value={10 * 1024 ** 3}>10 GiB</option><option value={20 * 1024 ** 3}>20 GiB</option><option value={50 * 1024 ** 3}>50 GiB</option></select></label>
          <div className="cache-actions"><button className="secondary-action" type="button" disabled={cacheBusy || !cacheStats || cacheStats.bytes === 0} onClick={async () => { setCacheBusy(true); try { const result = await window.desktopApi.pruneImageCache({ maxBytes: 0 }); setCacheMessage(`已清理 ${result.removedFiles} 个缓存文件。`); setCacheStats(await window.desktopApi.getImageCacheStats()); } catch { setCacheMessage('缓存清理失败，请稍后重试。'); } finally { setCacheBusy(false); } }}>{cacheBusy ? '清理中…' : '清理全部可重建缓存'}</button><span role="status">{cacheMessage}</span></div>
        </section>
        <section className="settings-section generation-trash-section">
          <div className="settings-heading"><div><h2>生成版本回收站</h2><p>回收版本仍可在照片的版本页恢复；永久清理不会触碰原图、活动版本或导出文件。</p></div><span><Trash2 size={14} />{trashSummary ? `${trashSummary.resultCount} 个版本 · ${formatStorageBytes(trashSummary.totalBytes)}` : '正在读取'}</span></div>
          <div className="generation-trash-row">
            <span><strong>{trashSummary?.resultCount ? '可恢复内容' : '回收站为空'}</strong><small>{trashSummary && (trashSummary.missingFiles > 0 || trashSummary.unsafePaths > 0) ? `${trashSummary.missingFiles} 个文件已缺失 · ${trashSummary.unsafePaths} 个异常路径将被保护性跳过` : '永久清理后无法恢复，版本序号仍不会复用。'}</small></span>
            <button className="danger-action" type="button" disabled={trashBusy || !trashSummary || trashSummary.resultCount === 0} onClick={() => setTrashConfirmationOpen(true)}>清空回收站</button>
          </div>
          <div className="form-feedback" role="status">{trashMessage}</div>
        </section>
        <section className="settings-section backup-section">
          <div className="settings-heading"><div><h2>图库备份</h2><p>数据库快照适合快速灾备；完整备份还包含集中受管的生成结果和逐文件校验清单，均不包含 API Key。</p></div><span><ShieldCheck size={14} />一致性快照</span></div>
          <div className="cache-actions"><button className="secondary-action" type="button" disabled={backupBusy || libraryBackupBusy || backupVerifyBusy || restoreBusy} onClick={() => void backupDatabase()}>{backupBusy ? '备份中…' : '仅备份数据库'}</button><button className="secondary-action" type="button" disabled={backupBusy || libraryBackupBusy || backupVerifyBusy || restoreBusy} onClick={() => void backupCompleteLibrary()}>{libraryBackupBusy ? '备份中…' : '完整图库备份'}</button><button className="secondary-action" type="button" disabled={backupBusy || libraryBackupBusy || backupVerifyBusy || restoreBusy} onClick={() => void verifyCompleteLibraryBackup()}>{backupVerifyBusy ? '验证中…' : '验证备份包'}</button><button className="secondary-action" type="button" disabled={backupBusy || libraryBackupBusy || backupVerifyBusy || restoreBusy} onClick={() => void restoreCompleteLibraryBackup()}>{restoreBusy ? '准备恢复…' : '从完整备份恢复'}</button><span role="status">{backupMessage || '恢复会保留当前图库副本；原图与便携结果不在备份包内。'}</span></div>
        </section>
        </>}
        {settingsSection === 'tasks' && <section className="settings-section settings-info-section">
          <div className="settings-heading"><div><h2>队列执行</h2><p>生成任务默认串行执行，保证显存和网络占用可预测。</p></div><span><Clock3 size={14} />持久化队列</span></div>
          <div className="settings-info-grid"><article><strong>并发策略</strong><span>图片分析与生成按队列顺序执行，等待中的任务可在任务中心调整。</span></article><article><strong>失败恢复</strong><span>失败任务保留错误状态和重试次数，不会覆盖已完成版本。</span></article><article><strong>取消边界</strong><span>取消只作用于尚未提交结果的任务，已落盘版本继续保留。</span></article></div>
        </section>}
        {settingsSection === 'shortcuts' && <section className="settings-section settings-info-section">
          <div className="settings-heading"><div><h2>工作流快捷键</h2><p>快捷键仅在图库焦点区域生效，输入框和对话框不会抢夺按键。</p></div><span><Command size={14} />键盘友好</span></div>
          <div className="shortcut-list"><span><kbd>⌘ / Ctrl</kbd><strong>+</strong><kbd>A</kbd><em>选择当前列表全部照片</em></span><span><kbd>0–5</kbd><em>设置选中照片评分</em></span><span><kbd>Shift</kbd><strong>+</strong><em>范围选择</em></span><span><kbd>⌘ / Ctrl</kbd><strong>+</strong><em>点击追加选择</em></span></div>
        </section>}
        {settingsSection === 'privacy' && <section className="settings-section settings-info-section">
          <div className="settings-heading"><div><h2>数据边界</h2><p>应用默认在本机管理图库和派生数据，只有执行 AI 任务时才向用户配置的服务发送图片。</p></div><span><ShieldCheck size={14} />不提供默认服务</span></div>
          <div className="settings-info-grid"><article><strong>凭据</strong><span>API Key 仅通过系统安全存储保存，不写入 SQLite、manifest 或诊断摘要。</span></article><article><strong>图片上传</strong><span>分析和生成使用缓存预览图发送，任务完成后服务端响应不会写入日志。</span></article><article><strong>诊断</strong><span>诊断摘要只包含版本、数量和缓存统计，不包含路径、密钥或图片内容。</span></article></div>
        </section>}
        <section className="settings-section diagnostics-section">
          <div className="settings-heading"><div><h2>诊断摘要</h2><p>仅包含运行统计，不包含路径、密钥、图片内容或模型响应。</p></div><span><ShieldCheck size={14} />可安全提交给支持团队</span></div>
          {diagnostics && <div className="diagnostic-health-strip"><span>自动备份：{diagnostics.startupRecovery.automaticBackup.status === 'completed' ? '已完成' : diagnostics.startupRecovery.automaticBackup.status === 'skipped' ? '已跳过' : diagnostics.startupRecovery.automaticBackup.status === 'failed' ? '失败' : '进行中'}</span><span>目录监听：{diagnostics.catalogWatcher.activeWatchers}/{diagnostics.catalogWatcher.watchedFolders}</span><span>监听失败：{diagnostics.catalogWatcher.watchFailures}</span><span>协调失败：{diagnostics.catalogWatcher.reconciliationFailures}</span></div>}
          {diagnostics && <div className="cache-actions"><button className="secondary-action compact" type="button" disabled={integrityBusy} onClick={() => void runIntegrityCheck()}><ShieldCheck size={13} />{integrityBusy ? '检查中…' : '重新检查图库'}</button><button className="secondary-action compact" type="button" onClick={() => void copyDiagnostics()}><Copy size={13} />复制脱敏摘要</button><button className="secondary-action compact" type="button" disabled={diagnosticBusy} onClick={() => void exportDiagnostics()}><Download size={13} />{diagnosticBusy ? '导出中…' : '导出诊断文件'}</button><span role="status">{diagnosticMessage}</span></div>}
          {diagnostics ? <div className="diagnostic-grid"><span>版本<strong>{diagnostics.appVersion}</strong></span><span>图库<strong>{diagnostics.catalog.assets} 张 · 离线 {diagnostics.catalog.offline}</strong></span><span className={`integrity-result is-${diagnostics.integrity.status}`}>完整性<strong>{diagnostics.integrity.status === 'healthy' ? '正常' : diagnostics.integrity.status === 'warning' ? '需关注' : '发现错误'}</strong><small>数据库 {diagnostics.integrity.databaseStatus === 'ok' ? '正常' : diagnostics.integrity.databaseStatus === 'corrupt' ? '损坏' : '无法读取'} · 活动缺失 {diagnostics.integrity.missingActiveFiles} · 孤立 {diagnostics.integrity.unexpectedGeneratedFiles + diagnostics.integrity.unexpectedTrashFiles} · 待恢复 {diagnostics.integrity.pendingGenerationWrites}（异常 {diagnostics.integrity.unsafeGenerationWriteIntents}）</small></span><span>启动恢复<strong>{diagnostics.startupRecovery.trashPurges.recovered + diagnostics.startupRecovery.fileOperations.resolved + diagnostics.startupRecovery.generationWrites.recovered} 项</strong><small>冲突 {diagnostics.startupRecovery.trashPurges.conflicts} · 失败 {diagnostics.startupRecovery.trashPurges.failed + diagnostics.startupRecovery.fileOperations.failed + diagnostics.startupRecovery.generationWrites.failed}</small></span><span>模型<strong>{diagnostics.providers.enabled}/{diagnostics.providers.total} 已启用</strong></span><span>缓存<strong>{(diagnostics.cache.bytes / 1_073_741_824).toFixed(2)} GiB</strong><small>命中 {diagnostics.cache.performance.hits} · 未命中 {diagnostics.cache.performance.misses}</small></span><span>解码<strong>{diagnostics.cache.performance.decodes} 次</strong><small>累计 {Math.round(diagnostics.cache.performance.decodeMsTotal)} ms</small></span><span>RAW 代理<strong>{diagnostics.cache.raw.imageMagick ? 'ImageMagick' : diagnostics.cache.raw.sips ? 'sips' : '未安装'}</strong><small>原生入口已启用；完整显影仍按发布计划推进</small></span></div> : <small>正在读取诊断摘要…</small>}
        </section>
      </main>
      {trashConfirmationOpen && trashSummary && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !trashBusy) setTrashConfirmationOpen(false); }}><section className="removal-dialog is-destructive" role="alertdialog" aria-modal="true" aria-labelledby="empty-trash-title" aria-describedby="empty-trash-description"><header><span className="dialog-icon"><Trash2 size={17} /></span><div><h2 id="empty-trash-title">永久清理 {trashSummary.resultCount} 个生成版本？</h2><p id="empty-trash-description">将释放约 {formatStorageBytes(trashSummary.totalBytes)}。这些版本及生成上下文会从当前图库永久移除，操作无法撤销。</p></div></header><div className="removal-impact"><CircleAlert size={15} /><span>只清理应用内部生成版本回收站。原图、活动生成版本、便携目录中的活动文件和已导出副本不会被删除。</span></div><footer><button autoFocus className="quiet-button" type="button" disabled={trashBusy} onClick={() => setTrashConfirmationOpen(false)}>取消</button><button className="danger-action" type="button" disabled={trashBusy} onClick={() => void emptyGenerationTrash()}>{trashBusy ? '正在清理…' : '永久清理'}</button></footer></section></div>}
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
  paused: '已暂停', failed: '失败', canceled: '已取消'
};

function taskSubtitle(task: PersistedTask): string {
  if (task.kind !== 'export' || !task.result) return task.assetId ?? '批量任务';
  const succeeded = typeof task.result.succeeded === 'number' ? task.result.succeeded : 0;
  const failed = typeof task.result.failed === 'number' ? task.result.failed : 0;
  return `成功 ${succeeded} · 失败 ${failed}`;
}

function exportFailureMessage(errorCode: string): string {
  switch (errorCode) {
    case 'EXPORT_RESULT_NOT_FOUND': return '生成版本不存在';
    case 'EXPORT_NAME_EXISTS': return '目标存在同名文件';
    case 'EXPORT_DECODE_FAILED': return '图片无法解码';
    case 'EXPORT_ENCODE_FAILED': return '图片编码失败';
    case 'EXPORT_SOURCE_CHANGED': return '源文件在导出时发生变化';
    case 'EXPORT_SOURCE_NOT_FILE': return '生成版本不是普通文件';
    default: return '文件写入失败';
  }
}

function exportTaskReport(task: PersistedTask): ExportReport | null {
  // Export results are validated and stripped of private fields at the main-process IPC boundary.
  return task.kind === 'export' && task.result ? task.result as ExportReport : null;
}

const fileOperationLabels: Record<FileOperationHistoryItem['kind'], string> = {
  move: '移动原图', copy: '复制原图', rename: '重命名', remove: '从图库移除', trash: '移到系统回收站'
};

const fileOperationStatusLabels: Record<FileOperationHistoryItem['status'], string> = {
  planned: '已计划', executing: '执行中', compensating: '恢复中', undoing: '撤销中', completed: '已完成', undone: '已撤销',
  partial: '部分完成', failed: '失败', compensation_failed: '需处理'
};

function TaskCenterPage({ onCatalogChanged }: { onCatalogChanged: () => Promise<void> }): React.JSX.Element {
  const [taskItems, setTaskItems] = useState<PersistedTask[]>([]);
  const [nextTaskCursor, setNextTaskCursor] = useState<TaskListCursor | null>(null);
  const [taskTotalCount, setTaskTotalCount] = useState(0);
  const [taskCounts, setTaskCounts] = useState({ queued: 0, paused: 0, active: 0, failed: 0, failedGeneration: 0 });
  const [loadingMoreTasks, setLoadingMoreTasks] = useState(false);
  const loadedTaskHistory = useRef(false);
  const [fileOperations, setFileOperations] = useState<FileOperationHistoryItem[]>([]);
  const [message, setMessage] = useState('');
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [generationProfiles, setGenerationProfiles] = useState<ProviderProfile[]>([]);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [providerDraft, setProviderDraft] = useState('');
  const [templateDraft, setTemplateDraft] = useState('');
  const [countDraft, setCountDraft] = useState(1);
  const [undoBusyId, setUndoBusyId] = useState<string | null>(null);
  const [expandedExportTaskId, setExpandedExportTaskId] = useState<string | null>(null);

  const applyTaskPage = (page: Awaited<ReturnType<typeof window.desktopApi.listTaskPage>>, append = false) => {
    setTaskItems((current) => append
      ? [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))]
      : page.items);
    setNextTaskCursor(page.nextCursor);
    setTaskTotalCount(page.totalCount);
    setTaskCounts({
      queued: page.queuedCount,
      paused: page.pausedCount,
      active: page.activeCount,
      failed: page.failedCount,
      failedGeneration: page.failedGenerationCount
    });
  };
  const refresh = async () => {
    const page = await window.desktopApi.listTaskPage({ limit: 50, cursor: null });
    loadedTaskHistory.current = false;
    applyTaskPage(page);
  };
  useEffect(() => {
    let active = true;
    const poll = async () => {
      const [page, operations] = await Promise.all([
        loadedTaskHistory.current
          ? Promise.resolve(null)
          : window.desktopApi.listTaskPage({ limit: 50, cursor: null }),
        window.desktopApi.listFileOperationHistory()
      ]);
      if (active) {
        if (page && !loadedTaskHistory.current) applyTaskPage(page);
        setFileOperations(operations);
      }
    };
    void poll();
    const interval = window.setInterval(poll, 1_000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);
  useEffect(() => {
    void Promise.all([window.desktopApi.listProviderProfiles(), window.desktopApi.listPromptTemplates()]).then(([profiles, items]) => {
      setGenerationProfiles(profiles.filter((profile) => profile.purpose === 'generation' && profile.enabled));
      setTemplates(items);
    });
  }, []);

  const cancel = async (taskId: string) => {
    await window.desktopApi.cancelTask(taskId);
    await refresh();
  };
  const retry = async (taskId: string) => {
    await window.desktopApi.retryTask(taskId);
    await refresh();
  };
  const pause = async (taskId: string) => {
    await window.desktopApi.pauseTask(taskId);
    await refresh();
  };
  const resume = async (taskId: string) => {
    await window.desktopApi.resumeTask(taskId);
    await refresh();
  };
  const moveQueued = async (taskId: string, direction: -1 | 1) => {
    await window.desktopApi.moveQueuedTask({ taskId, direction });
    await refresh();
  };
  const retryFailedGeneration = async () => {
    const report = await window.desktopApi.retryFailedGenerationTasks({ limit: 1_000 });
    setMessage(report.remaining > 0
      ? `已重新排队 ${report.retried} 个生成任务，仍有 ${report.remaining} 个待处理。`
      : `已重新排队 ${report.retried} 个生成任务。`);
    await refresh();
  };
  const loadMoreTasks = async () => {
    if (!nextTaskCursor || loadingMoreTasks) return;
    setLoadingMoreTasks(true);
    loadedTaskHistory.current = true;
    try {
      const page = await window.desktopApi.listTaskPage({ limit: 50, cursor: nextTaskCursor });
      applyTaskPage(page, true);
    } catch {
      loadedTaskHistory.current = false;
      setMessage('任务历史加载失败，请重试。');
    } finally {
      setLoadingMoreTasks(false);
    }
  };
  const undoFileOperation = async (operation: FileOperationHistoryItem) => {
    setUndoBusyId(operation.id);
    setMessage('');
    try {
      const report = await window.desktopApi.undoFileOperation({ operationId: operation.id });
      setMessage(report.status === 'completed'
        ? `已撤销${fileOperationLabels[operation.kind]}，恢复 ${report.undone} 张照片。`
        : `撤销失败：${fileOperationFailureMessage(report.errorCode)}，${report.rolledBack ? '文件已恢复到撤销前状态。' : '请检查操作历史。'}`);
      setFileOperations(await window.desktopApi.listFileOperationHistory());
      await onCatalogChanged();
    } catch (error) {
      const code = error instanceof Error ? error.message : null;
      setMessage(`无法撤销此操作：${fileOperationFailureMessage(code)}。`);
      setFileOperations(await window.desktopApi.listFileOperationHistory());
    } finally {
      setUndoBusyId(null);
    }
  };
  const openPromptEditor = (task: PersistedTask) => {
    const prompt = typeof task.payload.prompt === 'string' ? task.payload.prompt : '';
    setEditingTaskId(task.id);
    setPromptDraft(prompt);
    setProviderDraft(typeof task.payload.providerProfileId === 'string' ? task.payload.providerProfileId : '');
    setTemplateDraft(typeof task.payload.templateId === 'string' ? task.payload.templateId : '');
    const batchId = task.payload.batchId;
    setCountDraft(taskItems.filter((item) => item.kind === 'generation' && item.assetId === task.assetId && item.payload.batchId === batchId && item.status !== 'canceled').length || 1);
    setMessage('');
  };
  const previewTaskTemplate = async (templateId: string) => {
    setTemplateDraft(templateId);
    const task = taskItems.find((item) => item.id === editingTaskId);
    if (!task?.assetId || typeof task.payload.analysisRevisionId !== 'string') return;
    const template = templates.find((item) => item.id === templateId);
    if (templateId && !template) return;
    const revision = (await window.desktopApi.listAnalysisRevisions(task.assetId)).find((item) => item.id === task.payload.analysisRevisionId);
    if (!revision) return;
    const disabledActionIds = new Set(Array.isArray(task.payload.disabledActionIds) ? task.payload.disabledActionIds : []);
    setPromptDraft(composeGenerationPrompt({
      templateBody: template?.body ?? DEFAULT_GENERATION_TEMPLATE_BODY,
      analysis: {
        ...revision.result,
        generativeActions: revision.result.generativeActions.map((action) => ({
          ...action, enabled: action.enabled && !disabledActionIds.has(action.id)
        }))
      },
      userInstruction: typeof task.payload.userInstruction === 'string' ? task.payload.userInstruction : ''
    }));
  };
  const savePrompt = async () => {
    if (!editingTaskId || !promptDraft.trim()) return;
    setEditBusy(true);
    try {
      const task = taskItems.find((item) => item.id === editingTaskId);
      if (!task || typeof task.payload.batchId !== 'string' || !task.assetId) throw new Error('TASK_NOT_FOUND');
      let prompt = promptDraft;
      let templateId: string | null = typeof task.payload.templateId === 'string' ? task.payload.templateId : null;
      let templateVersion: number | null = typeof task.payload.templateVersion === 'number' ? task.payload.templateVersion : null;
      if (templateDraft !== (templateId ?? '')) {
        const template = templates.find((item) => item.id === templateDraft);
        const revisionId = task.payload.analysisRevisionId;
        if ((!templateDraft ? false : !template) || typeof revisionId !== 'string') throw new Error('TASK_TEMPLATE_CONTEXT_MISSING');
        const revision = (await window.desktopApi.listAnalysisRevisions(task.assetId)).find((item) => item.id === revisionId);
        if (!revision) throw new Error('TASK_TEMPLATE_CONTEXT_MISSING');
        const disabledActionIds = new Set(Array.isArray(task.payload.disabledActionIds) ? task.payload.disabledActionIds : []);
        const analysis: AnalysisResult = {
          ...revision.result,
          generativeActions: revision.result.generativeActions.map((action) => ({
            ...action,
            enabled: action.enabled && !disabledActionIds.has(action.id)
          }))
        };
        prompt = composeGenerationPrompt({
          templateBody: template?.body ?? DEFAULT_GENERATION_TEMPLATE_BODY,
          analysis,
          userInstruction: typeof task.payload.userInstruction === 'string' ? task.payload.userInstruction : ''
        });
        templateId = template?.id ?? null;
        templateVersion = template?.version ?? null;
      }
      const batchTaskIds = taskItems.filter((item) =>
        item.kind === 'generation' && item.status === 'queued' && item.assetId === task.assetId && item.payload.batchId === task.payload.batchId
      ).map((item) => item.id);
      await window.desktopApi.updateQueuedGenerationTasks({
        taskIds: batchTaskIds, providerProfileId: providerDraft, prompt, templateId, templateVersion,
        resize: { batchId: task.payload.batchId, assetId: task.assetId, count: countDraft }
      });
      setEditingTaskId(null);
      setMessage('等待任务的模型、模板、提示词和生成数量已更新。');
      await refresh();
    } catch {
      setMessage('任务已开始或内容无效，无法继续修改。');
    } finally {
      setEditBusy(false);
    }
  };

  const waiting = taskCounts.queued;
  const failed = taskCounts.failed;
  const failedGeneration = taskCounts.failedGeneration;
  const queuedIds = taskItems.filter((task) => task.status === 'queued').map((task) => task.id);

  return (
    <div className="task-center-page">
      <div className="task-center-heading">
        <div><h1>任务中心</h1><p>生成任务默认串行执行，当前显示 {taskItems.length}/{taskTotalCount} 项。</p></div>
        <div className="task-heading-actions">
          {message && <span className="task-feedback" role="status">{message}</span>}
          <button className="secondary-action" type="button" disabled={failedGeneration === 0} onClick={() => void retryFailedGeneration()}><RotateCcw size={13} />重试失败生成 ({failedGeneration})</button>
          <div className="task-summary"><span><i className="task-dot queued" />等待 {waiting}</span><span>运行 {taskCounts.active}</span><span>暂停 {taskCounts.paused}</span><span><i className="task-dot failed" />失败 {failed}</span></div>
        </div>
      </div>
      <div className="task-table">
        <div className="task-table-head"><span>任务</span><span>状态</span><span>进度</span><span>尝试</span><span>更新时间</span><span /></div>
        {taskItems.length === 0 ? (
          <div className="task-empty"><Clock3 size={30} /><h2>暂无任务</h2><p>从图库选择照片并执行 AI 分析或生成后，任务会出现在这里。</p></div>
        ) : taskItems.map((task) => {
          const report = exportTaskReport(task);
          const reportOpen = expandedExportTaskId === task.id;
          return <Fragment key={task.id}>
          <div className="task-table-row">
            <span className="task-kind"><i><TaskKindIcon kind={task.kind} /></i><span><strong>{taskLabels[task.kind]}</strong><small>{taskSubtitle(task)}</small></span></span>
            <span className={`task-state state-${task.status}`}>{statusLabels[task.status]}</span>
            <span className="table-progress"><i style={{ width: `${Math.round(task.progress * 100)}%` }} /><em>{Math.round(task.progress * 100)}%</em></span>
            <span>{task.attempt + 1}</span>
            <span>{new Date(task.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <span className="task-row-actions">
              {task.status === 'queued' && <><IconButton label="任务上移" disabled={queuedIds.indexOf(task.id) === 0} onClick={() => void moveQueued(task.id, -1)}><ArrowUp size={13} /></IconButton><IconButton label="任务下移" disabled={queuedIds.indexOf(task.id) === queuedIds.length - 1 && taskCounts.queued <= queuedIds.length} onClick={() => void moveQueued(task.id, 1)}><ArrowDown size={13} /></IconButton></>}
              {task.status === 'queued' && task.kind === 'generation' && <IconButton label="编辑生成提示词" onClick={() => openPromptEditor(task)}><FilePenLine size={13} /></IconButton>}
              {(task.status === 'queued' || task.status === 'preparing' || task.status === 'uploading' || task.status === 'processing' || task.status === 'downloading') && <IconButton label="暂停任务" onClick={() => void pause(task.id)}><Pause size={13} /></IconButton>}
              {task.status === 'paused' && <IconButton label="恢复任务" onClick={() => void resume(task.id)}><Play size={13} /></IconButton>}
              {(task.status === 'queued' || task.status === 'paused' || task.status === 'preparing' || task.status === 'uploading' || task.status === 'processing' || task.status === 'downloading') && <button type="button" onClick={() => void cancel(task.id)}>取消</button>}
              {(task.status === 'failed' || task.status === 'canceled') && <button type="button" onClick={() => void retry(task.id)}>重试</button>}
              {report && <IconButton label={reportOpen ? '收起导出报告' : '查看导出报告'} active={reportOpen} pressed={reportOpen} onClick={() => setExpandedExportTaskId(reportOpen ? null : task.id)}>{reportOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</IconButton>}
            </span>
          </div>
          {reportOpen && report && <section className="export-task-report" aria-label="导出报告">
            <header><span><strong>导出报告</strong><small>{report.canceled ? '已取消' : report.failed > 0 ? '部分项目未导出' : '所有文件均已导出'}</small></span><button className="secondary-action compact" type="button" onClick={async () => { if (!await window.desktopApi.revealExportDestination(task.id)) setMessage('导出目录已移动或暂时无法打开。'); }}><FolderOpen size={13} />打开导出目录</button></header>
            <div className="export-report-summary"><span>总计 <strong>{report.total}</strong></span><span>成功 <strong>{report.succeeded}</strong></span><span className={report.failed > 0 ? 'has-failures' : ''}>失败 <strong>{report.failed}</strong></span></div>
            <div className="export-report-files">
              {report.files.map((file) => <div key={file.resultId}><Check size={12} /><span>{file.fileName}</span><em>已导出</em></div>)}
              {report.failures.map((failure) => <div className="is-failed" key={failure.resultId}><CircleAlert size={12} /><span>{exportFailureMessage(failure.errorCode)}</span><em>{failure.errorCode}</em></div>)}
              {report.files.length === 0 && report.failures.length === 0 && <div className="is-empty">任务取消前没有发布文件</div>}
            </div>
          </section>}
          </Fragment>;
        })}
        {nextTaskCursor && <div className="task-load-more"><button className="secondary-action compact" type="button" disabled={loadingMoreTasks} onClick={() => void loadMoreTasks()}>{loadingMoreTasks ? '加载中…' : '加载更多任务'}</button></div>}
      </div>
      {editingTaskId && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !editBusy) setEditingTaskId(null); }}><form className="rename-dialog task-prompt-editor" role="dialog" aria-modal="true" aria-labelledby="task-prompt-title" onSubmit={(event) => { event.preventDefault(); void savePrompt(); }}><header><div><span className="dialog-icon"><FilePenLine size={16} /></span><div><h2 id="task-prompt-title">编辑等待任务</h2><p>修改只作用于尚未开始的任务；同批生成数量会安全增减队尾任务。</p></div></div><IconButton label="关闭提示词编辑器" disabled={editBusy} onClick={() => setEditingTaskId(null)}><X size={15} /></IconButton></header><div className="form-grid two-columns"><label className="rename-field"><span>生成模型</span><select aria-label="任务生成模型" value={providerDraft} onChange={(event) => setProviderDraft(event.target.value)}>{generationProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><label className="rename-field"><span>生成数量</span><input aria-label="任务生成数量" type="number" min="1" max="20" value={countDraft} onChange={(event) => setCountDraft(Number(event.target.value))} /></label></div><label className="rename-field"><span>提示词模板</span><select aria-label="任务提示词模板" value={templateDraft} disabled={!taskItems.find((item) => item.id === editingTaskId)?.payload.analysisRevisionId} onChange={(event) => void previewTaskTemplate(event.target.value)}><option value="">保留当前通用方案</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name} · V{template.version}</option>)}</select></label><label className="rename-field"><span>最终生成提示词</span><textarea autoFocus value={promptDraft} maxLength={50_000} onChange={(event) => setPromptDraft(event.target.value)} /></label><footer><span>{promptDraft.length.toLocaleString()} / 50,000</span><div><button className="quiet-button" type="button" disabled={editBusy} onClick={() => setEditingTaskId(null)}>取消</button><button className="primary-action compact" type="submit" disabled={!providerDraft || !promptDraft.trim() || countDraft < 1 || countDraft > 20 || editBusy}>{editBusy ? '保存中…' : '保存修改'}</button></div></footer></form></div>}
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
                <span className="operation-actions">{operation.undoable && <IconButton label={`撤销${fileOperationLabels[operation.kind]}`} disabled={undoBusyId !== null} onClick={() => void undoFileOperation(operation)}><RotateCcw size={13} /></IconButton>}</span>
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
  exampleId: 'portrait',
  body: '{{analysis.summary}}\n\n需要执行：\n{{analysis.generative_actions}}\n\n用户补充：\n{{user_instruction}}\n\n必须保留：\n{{preservation_rules}}'
};

function TemplatePage(): React.JSX.Element {
  const [templateItems, setTemplateItems] = useState<PromptTemplate[]>([]);
  const [form, setForm] = useState<SavePromptTemplateInput>(emptyTemplateForm);
  const [previewTemplate, setPreviewTemplate] = useState<PromptTemplate | null>(null);
  const [templateSearch, setTemplateSearch] = useState('');
  const [templateCategory, setTemplateCategory] = useState('全部分类');
  const [message, setMessage] = useState('');
  const [archiveCandidate, setArchiveCandidate] = useState<string | null>(null);

  useEffect(() => { void window.desktopApi.listPromptTemplates().then(setTemplateItems); }, []);

  useEffect(() => {
    if (!previewTemplate) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewTemplate(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewTemplate]);

  const patchTemplate = <Key extends keyof SavePromptTemplateInput>(key: Key, value: SavePromptTemplateInput[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setMessage('');
    setArchiveCandidate(null);
  };

  const archiveTemplate = async () => {
    if (!form.id) return;
    if (archiveCandidate !== form.id) {
      setArchiveCandidate(form.id);
      setMessage('再次点击确认归档。历史任务仍保留模板 ID 和版本。');
      return;
    }
    try {
      await window.desktopApi.archivePromptTemplate(form.id);
      setTemplateItems((current) => current.filter((template) => template.id !== form.id));
      setForm(emptyTemplateForm);
      setArchiveCandidate(null);
      setMessage('模板已归档，不再用于新任务。');
    } catch {
      setMessage('模板归档失败，请刷新后重试。');
    }
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

  const visibleTemplates = useMemo(() => {
    const query = templateSearch.trim().toLocaleLowerCase();
    return templateItems.filter((template) => {
      const matchesCategory = templateCategory === '全部分类' || template.category === templateCategory;
      const matchesQuery = !query || [template.name, template.description, template.body].some((value) => value.toLocaleLowerCase().includes(query));
      return matchesCategory && matchesQuery;
    });
  }, [templateCategory, templateItems, templateSearch]);

  return (
    <div className="template-page">
      <div className="template-page-heading">
        <div><h1>提示词模板</h1><p>模板与 AI 分析动作组合，入队时保存具体版本快照。</p></div>
        <button className="primary-action compact" type="button" onClick={() => { setForm(emptyTemplateForm); setMessage(''); }}><Plus size={15} />新建模板</button>
      </div>
      <div className="template-workspace">
        <section className="template-browser">
          <div className="template-browser-tools"><div className="inline-search"><Search size={14} /><input aria-label="搜索模板" value={templateSearch} placeholder="搜索模板" onChange={(event) => setTemplateSearch(event.target.value)} /></div><label className="template-category-filter"><ListFilter size={14} /><select aria-label="模板分类" value={templateCategory} onChange={(event) => setTemplateCategory(event.target.value)}><option>全部分类</option><option>人像</option><option>风光</option><option>商品</option><option>建筑</option><option>其他</option></select></label></div>
          {templateItems.length === 0 ? (
            <div className="template-empty"><WandSparkles size={30} /><h2>尚未创建模板</h2><p>创建第一个模板，把常用修图要求和保护规则保存下来。</p></div>
          ) : visibleTemplates.length === 0 ? (
            <div className="template-empty"><Search size={30} /><h2>没有匹配模板</h2><p>尝试更换搜索词或分类筛选。</p></div>
          ) : (
            <div className="template-grid">
              {visibleTemplates.map((template, index) => (
                <button className={`template-card${form.id === template.id ? ' is-selected' : ''}`} key={template.id} type="button" onClick={() => setForm({
                  id: template.id,
                  name: template.name,
                  description: template.description,
                  category: template.category,
                  body: template.body,
                  exampleId: template.exampleId
                })}>
                  <span className="template-card-image"><img src={`./demo/${template.exampleId === 'none' ? ['portrait', 'street', 'coast'][index % 3] : template.exampleId}.jpg`} alt={`${template.name} 示例`} /><i>{template.category}</i></span>
                  <span className="template-card-copy"><strong>{template.name}</strong><small>{template.description || '暂无描述'}</small><em>版本 {template.version}</em></span>
                </button>
              ))}
            </div>
          )}
        </section>
        <form className="template-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <div className="template-editor-head"><div><strong>{form.id ? '编辑模板' : '创建模板'}</strong><small>保存修改会创建新版本</small></div><div className="template-editor-head-actions">{form.id && <button className="secondary-action compact" type="button" onClick={() => setPreviewTemplate(templateItems.find((template) => template.id === form.id) ?? null)}><Maximize2 size={13} />预览模板</button>}{form.id && <span>不可变版本</span>}</div></div>
          <label><span>模板名称</span><input required maxLength={120} value={form.name} placeholder="例如：自然人像 · 清洁背景" onChange={(event) => patchTemplate('name', event.target.value)} /></label>
          <div className="form-grid two-columns"><label><span>分类</span><select value={form.category} onChange={(event) => patchTemplate('category', event.target.value)}><option>人像</option><option>风光</option><option>商品</option><option>建筑</option><option>其他</option></select></label><label><span>示例图片</span><select value={form.exampleId} onChange={(event) => patchTemplate('exampleId', event.target.value as SavePromptTemplateInput['exampleId'])}><option value="portrait">人像示例</option><option value="street">街拍示例</option><option value="coast">海岸示例</option><option value="none">不使用示例</option></select></label></div>
          <label><span>简短描述</span><input maxLength={2_000} value={form.description} placeholder="说明适用场景和效果" onChange={(event) => patchTemplate('description', event.target.value)} /></label>
          <label className="template-body-field"><span>模板正文</span><textarea required value={form.body} onChange={(event) => patchTemplate('body', event.target.value)} /></label>
          <div className="template-variables"><span>可用变量</span>{['analysis.summary', 'analysis.generative_actions', 'catalog.subjects', 'user_instruction', 'preservation_rules'].map((variable) => <code key={variable}>{`{{${variable}}}`}</code>)}</div>
          <div className="template-editor-footer"><span role="status">{message}</span>{form.id && <button className="danger-action compact" type="button" onClick={() => void archiveTemplate()}>{archiveCandidate === form.id ? '确认归档' : '归档模板'}</button>}<button className="primary-action compact" type="submit">{form.id ? '保存新版本' : '创建模板'}</button></div>
        </form>
      </div>
      {previewTemplate && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewTemplate(null); }}><section className="template-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="template-preview-title"><header><div><span className="dialog-icon"><WandSparkles size={16} /></span><div><h2 id="template-preview-title">{previewTemplate.name}</h2><p>{previewTemplate.category} · 版本 {previewTemplate.version}</p></div></div><IconButton label="关闭模板预览" onClick={() => setPreviewTemplate(null)}><X size={15} /></IconButton></header><div className="template-preview-content">{previewTemplate.exampleId === 'none' ? <div className="template-preview-placeholder"><Image size={28} /><span>未设置示例图片</span></div> : <img className="template-preview-hero" src={`./demo/${previewTemplate.exampleId}.jpg`} alt={`${previewTemplate.name} 示例图片`} />}<div className="template-preview-meta"><span className="template-preview-category">{previewTemplate.category}</span><span>版本 {previewTemplate.version}</span></div><p className="template-preview-description">{previewTemplate.description || '暂无描述'}</p><div className="template-preview-body"><strong>模板正文</strong><pre>{previewTemplate.body}</pre></div></div><footer><button className="quiet-button" type="button" onClick={() => setPreviewTemplate(null)}>关闭</button><button className="primary-action compact" type="button" onClick={() => { setForm({ id: previewTemplate.id, name: previewTemplate.name, description: previewTemplate.description, category: previewTemplate.category, body: previewTemplate.body, exampleId: previewTemplate.exampleId }); setPreviewTemplate(null); }}>编辑模板</button></footer></section></div>}
    </div>
  );
}

export function App(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('library');
  const [openTabs, setOpenTabs] = useState<WorkspaceTab[]>(['library']);
  const [sessionReady, setSessionReady] = useState(false);
  const [catalogPhotos, setCatalogPhotos] = useState<Photo[]>([]);
  const [catalogFolders, setCatalogFolders] = useState<CatalogFolder[]>([]);
  const [catalogAlbums, setCatalogAlbums] = useState<CatalogAlbum[]>([]);
  const [catalogSmartCollections, setCatalogSmartCollections] = useState<CatalogSmartCollection[]>([]);
  const [catalogTags, setCatalogTags] = useState<CatalogTag[]>([]);
  const [exportPresets, setExportPresets] = useState<ExportPreset[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [selectedSmartCollection, setSelectedSmartCollection] = useState<CatalogSmartCollection['id'] | null>(null);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [viewerPreloading, setViewerPreloading] = useState(false);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<CatalogAssetCursor | null>(null);
  const [catalogReady, setCatalogReady] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchDraft, setSearchDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [sortBy, setSortBy] = useState<CatalogSort>('modifiedAt');
  const catalogRequest = useRef(0);

  useEffect(() => {
    let preference: AppSettings['theme'] = 'system';
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const refresh = () => applyTheme(preference);
    const onThemeChange = (event: Event) => {
      preference = (event as CustomEvent<AppSettings['theme']>).detail;
      refresh();
    };
    void window.desktopApi.getAppSettings().then((settings) => {
      preference = settings.theme;
      refresh();
    });
    media.addEventListener('change', refresh);
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
    return () => {
      media.removeEventListener('change', refresh);
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
    };
  }, []);

  useEffect(() => {
    void window.desktopApi.listExportPresets().then(setExportPresets);
  }, []);

  useEffect(() => {
    let active = true;
    void window.desktopApi.getWorkspaceSession().then((session) => {
      if (!active) return;
      setOpenTabs(session.openTabs);
      setActiveTab(session.activeTab);
      setSelectedFolderId(session.library.selectedFolderId);
      setSelectedAlbumId(session.library.selectedAlbumId);
      setSelectedSmartCollection(session.library.selectedSmartCollection);
      setSelectedTagId(session.library.selectedTagId);
      setSelectedAssetId(session.library.selectedAssetId);
      setFavoriteOnly(session.library.favoriteOnly);
      setSortBy(session.library.sortBy);
      setSearchDraft(session.library.searchQuery);
      setSearchQuery(session.library.searchQuery);
      setSessionReady(true);
    }).catch(() => setSessionReady(true));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!sessionReady) return;
    const session: WorkspaceSession = {
      version: 2,
      openTabs,
      activeTab,
      library: { selectedFolderId, selectedAlbumId, selectedSmartCollection, selectedTagId, selectedAssetId, favoriteOnly, sortBy, searchQuery: searchDraft.trim() }
    };
    const timeout = window.setTimeout(() => {
      void window.desktopApi.saveWorkspaceSession(session).catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timeout);
  }, [activeTab, favoriteOnly, openTabs, searchDraft, selectedAlbumId, selectedAssetId, selectedFolderId, selectedSmartCollection, selectedTagId, sessionReady, sortBy]);

  const refreshCatalog = useCallback(async (folderId: string | null = selectedFolderId) => {
    const request = ++catalogRequest.current;
    setLoadingMore(true);
    try {
      const [page, folders, tags, albums, smartCollections] = await Promise.all([
        window.desktopApi.listCatalogAssetPage({ folderId, tagId: selectedTagId, albumId: selectedAlbumId, smartCollection: selectedSmartCollection, favoriteOnly, sortBy, query: searchQuery, cursor: null, limit: 200 }),
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
  }, [favoriteOnly, searchQuery, selectedAlbumId, selectedFolderId, selectedSmartCollection, selectedTagId, sortBy]);

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

  const relinkFolder = async (folderId: string) => {
    const result = await window.desktopApi.relinkCatalogFolder(folderId);
    if (result) await refreshCatalog();
  };

  const unregisterFolder = async (folderId: string) => {
    await window.desktopApi.unregisterCatalogFolder({ folderId });
    setSelectedFolderId(null);
    setSelectedAssetId(null);
    await refreshCatalog(null);
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
        favoriteOnly,
        sortBy,
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

  const isDemo = E2E_DEMO_MODE && catalogReady && catalogTotal === 0 && catalogFolders.length === 0;
  const availablePhotos = !catalogReady || isDemo ? photos : catalogPhotos;
  const displayTotal = isDemo ? 128 : catalogTotal;
  const workspaceProps: LibraryWorkspaceProps = {
    availablePhotos,
    catalogFolders,
    catalogAlbums,
    catalogSmartCollections,
    catalogTags,
    exportPresets,
    isDemo,
    selectedFolderId,
    selectedAlbumId,
    selectedSmartCollection,
    selectedTagId,
    selectedAssetId,
    totalCount: displayTotal,
    favoriteOnly,
    sortBy,
    hasMore: nextCursor !== null,
    loadingMore,
    searchQuery,
    onSelectedAssetChange: setSelectedAssetId,
    onFavoriteOnlyChange: setFavoriteOnly,
    onSortByChange: setSortBy,
    onSelectFolder: (id) => { setSelectedFolderId(id); setSelectedAlbumId(null); setSelectedSmartCollection(null); },
    onSelectAlbum: (id) => { setSelectedAlbumId(id); setSelectedFolderId(null); setSelectedSmartCollection(null); },
    onSelectSmartCollection: (id) => { setSelectedSmartCollection(id); setSelectedFolderId(null); setSelectedAlbumId(null); },
    onSelectTag: setSelectedTagId,
    onLoadMore: () => void loadMoreCatalog(),
    onRefreshCatalog: refreshCatalog,
    onRefreshAlbums: refreshCatalog,
    onImportFolders: importFolders,
    onRelinkFolder: relinkFolder,
    onUnregisterFolder: unregisterFolder,
    onOpenTaskCenter: () => openWorkspaceTab('tasks'),
    onOpenTemplates: () => openWorkspaceTab('templates')
  };
  const openViewer = async (assetId: string) => {
    const photo = availablePhotos.find((item) => item.id === assetId);
    if (!photo || activeTab === 'viewer' && selectedAssetId === assetId) {
      setSelectedAssetId(assetId);
      openWorkspaceTab('viewer');
      return;
    }
    setViewerPreloading(true);
    try {
      if (photo.src) {
        const image = new window.Image();
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => { if (settled) return; settled = true; resolve(); };
          const decode = () => { void image.decode().then(finish, finish); };
          image.onload = decode;
          image.onerror = finish;
          window.setTimeout(finish, 1_500);
          image.src = photo.src;
          if (image.complete) {
            if (image.naturalWidth > 0) decode();
            else finish();
          }
        });
      }
      setSelectedAssetId(assetId);
      openWorkspaceTab('viewer');
    } finally {
      setViewerPreloading(false);
    }
  };

  return (
    <div className="app-shell">
      <AppHeader active={activeTab} openTabs={openTabs} onChange={setActiveTab} onClose={closeWorkspaceTab} onOpen={openWorkspaceTab} onImport={() => void importFolders()} search={searchDraft} onSearchChange={setSearchDraft} />
      {!sessionReady || !catalogReady ? <main className="workspace-loading"><span className="working-pulse" /><span>{sessionReady ? '正在读取图库' : '正在恢复工作区'}</span></main>
        : activeTab === 'library' ? <><CatalogWorkspace {...workspaceProps} onOpenViewer={(assetId) => void openViewer(assetId)} />{viewerPreloading && <div className="viewer-preload-indicator" role="status"><span className="working-pulse" />正在准备预览</div>}</>
          : activeTab === 'viewer' ? <LibraryWorkspace {...workspaceProps} />
            : activeTab === 'settings' ? <SettingsPage onExportPresetsChange={setExportPresets} />
              : activeTab === 'tasks' ? <TaskCenterPage onCatalogChanged={refreshCatalog} />
                : <TemplatePage />}
    </div>
  );
}
