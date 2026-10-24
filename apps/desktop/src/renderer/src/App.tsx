import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ViewerToolbar } from './viewer-toolbar';
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
  TaskPage,
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
  AppSettings,
  MenuCommand
} from '@photoallisai/contracts';
import { analysisResultSchema, collectionAnalysisReportSchema, generationResultSchema, agentTaskResultSchema } from '@photoallisai/contracts';
import { groupTaskBatches, batchProgress } from './task-batches';
import { TaskActions, TaskClearButton, TaskBatchButtons, TASKS_CHANGED_EVENT } from './task-actions';
import { computeHorizontalWindow, composeGenerationPrompt, pickExportResults, selectAll, updateSelection, type ExportSelectionMode, type SelectionIntent, type SelectionState } from '@photoallisai/domain';
import { getLocale, setLocale, t, useLocale, type Locale } from './i18n';
import {
  Aperture,
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
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
  RefreshCw,
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
import { analysisFailureMessage, fileOperationFailureMessage } from './error-messages';

const THEME_CHANGE_EVENT = 'photoallisai-theme-change';
const OPEN_TASK_DRAWER_EVENT = 'photoallisai-open-task-drawer';
const OPERATION_NOTICE_EVENT = 'photoallisai-operation-notice';
const E2E_DEMO_MODE = new URLSearchParams(window.location.search).get('e2e-demo') === '1';
const DECODED_IMAGE_SOURCES = new Set<string>();
const IMAGE_ASPECT_RATIOS = new Map<string, number>();
const FILE_MANAGER_LABEL = navigator.userAgent.includes('Mac') ? '在访达中显示' : '在文件资源管理器中显示';
const DEFAULT_GENERATION_TEMPLATE_BODY = [
  '请基于原图进行专业且写实的修图。',
  '画面分析：{{analysis.summary}}',
  '编辑动作：\n{{analysis.generative_actions}}',
  '补充要求：{{user_instruction}}',
  '必须保留：\n{{preservation_rules}}'
].join('\n');

function preparePhotoDrag(event: React.DragEvent, photo: Photo, selection: SelectionState): string[] {
  const assetIds = selection.selectedIds.has(photo.id) ? [...selection.selectedIds] : [photo.id];
  event.dataTransfer.effectAllowed = 'copyMove';
  event.dataTransfer.setData('application/x-photoallisai-assets', JSON.stringify(assetIds));
  event.dataTransfer.setData('text/plain', assetIds.length === 1 ? photo.fileName : `${assetIds.length} 张照片`);
  const preview = document.createElement('div');
  preview.className = 'photo-drag-preview';
  preview.textContent = assetIds.length === 1 ? photo.fileName : `拖拽 ${assetIds.length} 张照片`;
  document.body.append(preview);
  event.dataTransfer.setDragImage(preview, 18, 18);
  window.setTimeout(() => preview.remove(), 0);
  return assetIds;
}

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
const VIEWER_LAYOUT_CHANGE_EVENT = 'photoallisai-viewer-layout-change';
const DEFAULT_VIEWER_LAYOUT: ViewerLayout = { leftWidth: 224, rightWidth: 300, filmstripHeight: 160 };
const INSPECTOR_TAB_KEY = 'photoallisai.inspector-tab.v1';
type InspectorTab = 'ai' | 'agent' | 'details';
function useInspectorTab(): [InspectorTab, (tab: InspectorTab) => void] {
  const [tab, setTab] = useState<InspectorTab>(() => {
    const saved = window.localStorage.getItem(INSPECTOR_TAB_KEY);
    return saved === 'agent' ? 'agent' : saved === 'details' || saved === 'info' || saved === 'versions' ? 'details' : 'ai';
  });
  const update = useCallback((next: InspectorTab) => { setTab(next); window.localStorage.setItem(INSPECTOR_TAB_KEY, next); }, []);
  return [tab, update];
}

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
    setLayout((current) => {
      const next = { ...current, [key]: clamp(Math.round(value), limits[0]!, limits[1]!) };
      window.localStorage.setItem(VIEWER_LAYOUT_KEY, JSON.stringify(next));
      window.dispatchEvent(new CustomEvent<ViewerLayout>(VIEWER_LAYOUT_CHANGE_EVENT, { detail: next }));
      return next;
    });
  }, []);
  useEffect(() => {
    const synchronize = (event: Event) => setLayout((event as CustomEvent<ViewerLayout>).detail);
    window.addEventListener(VIEWER_LAYOUT_CHANGE_EVENT, synchronize);
    return () => window.removeEventListener(VIEWER_LAYOUT_CHANGE_EVENT, synchronize);
  }, []);
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
  const [ready, setReady] = useState(() => DECODED_IMAGE_SOURCES.has(src));
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
      setReady(true);
      DECODED_IMAGE_SOURCES.add(src);
      onReady?.(image);
    };
    image.onerror = () => {
      if (!active) return;
      setDisplayed({ src: '', alt });
      setFailedSrc(src);
      setLoading(false);
      setReady(false);
    };
    image.src = src;
    return () => { active = false; };
  }, [alt, displayed.src, failedSrc, onReady, src]);
  return <>{displayed.src ? <img className={`${className} buffered-image${ready ? ' is-ready' : ''}`} src={displayed.src} alt={displayed.alt} onLoad={(event) => { DECODED_IMAGE_SOURCES.add(displayed.src); if (event.currentTarget.naturalHeight > 0) IMAGE_ASPECT_RATIOS.set(displayed.src, event.currentTarget.naturalWidth / event.currentTarget.naturalHeight); setReady(true); onReady?.(event.currentTarget); }} /> : null}{loading && <span className="preview-loading" aria-label="正在载入下一张照片"><span className="working-pulse" /></span>}</>;
}

function CatalogImage({ src, alt = '' }: { src: string; alt?: string }): React.JSX.Element {
  const [readySrc, setReadySrc] = useState<string | null>(null);
  return <img className={readySrc === src ? 'is-ready' : ''} src={src} alt={alt} onLoad={() => setReadySrc(src)} onError={(event) => { event.currentTarget.style.display = 'none'; }} />;
}

type CompareMode = 'single' | 'split';
type CatalogSort = 'modifiedAt' | 'fileName' | 'rating';
type CatalogViewMode = 'list' | 'grid' | 'analysis';

const tabs: { id: Exclude<WorkspaceTab, `task:${string}`>; label: string; icon: typeof Image }[] = [
  { id: 'library', label: '图库', icon: LibraryBig },
  { id: 'batch', label: 'AI 批量修图', icon: Sparkles },
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
  useLocale();
  const localizedTabs = tabs.map((tab) => ({ ...tab, label: t(tab.id) }));
  const [menuOpen, setMenuOpen] = useState(false);
  const closedTabs = localizedTabs.filter((tab) => !openTabs.includes(tab.id));
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
        const tab = tabId.startsWith('task:')
          ? { id: tabId, label: `${taskLabels[tabId.split(':')[1] as PersistedTask['kind']] ?? '任务'} · ${tabId.split(':').at(-1)?.slice(0, 6)}`, icon: Clock3 }
          : localizedTabs.find((item) => item.id === (tabId === 'workflow' ? 'batch' : tabId));
        if (!tab) return null;
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
  onSynchronizeFolder,
  onRevealFolder,
  onUnregisterFolder,
  onMoveFolder,
  onDropAssets,
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
  onSynchronizeFolder: (folderId: string) => Promise<{ discovered: number; offline: number }>;
  onRevealFolder: (folderId: string) => Promise<boolean>;
  onUnregisterFolder: (folderId: string) => Promise<void>;
  onMoveFolder: (sourceFolderId: string, targetFolderId: string) => Promise<CatalogFolder>;
  onDropAssets?: (folderId: string, assetIds: string[], copy: boolean) => Promise<void>;
  onSelectTag: (tagId: string | null) => void;
  isDemo: boolean;
}): React.JSX.Element {
  const [albumManagerOpen, setAlbumManagerOpen] = useState(false);
  const [albumName, setAlbumName] = useState('');
  const [editingAlbumId, setEditingAlbumId] = useState<string | null>(null);
  const [albumBusy, setAlbumBusy] = useState(false);
  const [albumContextMenu, setAlbumContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [albumDeleteCandidate, setAlbumDeleteCandidate] = useState<CatalogAlbum | null>(null);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [tagDeleteCandidate, setTagDeleteCandidate] = useState<string | null>(null);
  const [tagBusy, setTagBusy] = useState(false);
  const [folderRemovalCandidate, setFolderRemovalCandidate] = useState<CatalogFolder | null>(null);
  const [folderRemovalBusy, setFolderRemovalBusy] = useState(false);
  const [folderRemovalError, setFolderRemovalError] = useState('');
  const [folderRenameCandidate, setFolderRenameCandidate] = useState<CatalogFolder | null>(null);
  const [folderRenameDraft, setFolderRenameDraft] = useState('');
  const [folderRenameBusy, setFolderRenameBusy] = useState(false);
  const [folderAppearance, setFolderAppearance] = useState<FolderAppearance>(loadFolderAppearance);
  const [folderContextMenu, setFolderContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [folderActionBusy, setFolderActionBusy] = useState(false);
  const [folderActionNotice, setFolderActionNotice] = useState('');
  const [folderDropTargetId, setFolderDropTargetId] = useState<string | null>(null);
  const [draggedFolderId, setDraggedFolderId] = useState<string | null>(null);
  const folderDropCopies = useRef(false);
  const visibleFolders = isDemo
    ? demoFolders.map((folder, index) => ({ id: `demo-${index}`, name: folder.name, assetCount: folder.count, offlineCount: 0, parentId: null, rootId: `demo-${index}`, depth: 0, isRoot: true }))
    : folders;
  const selectedOfflineFolder = visibleFolders.find((folder) => folder.id === selectedFolderId && folder.isRoot && folder.offlineCount > 0);
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
  const contextFolder = folderContextMenu ? visibleFolders.find((folder) => folder.id === folderContextMenu.id) : undefined;
  const contextHasChildren = contextFolder ? (folderChildren.get(contextFolder.id)?.length ?? 0) > 0 : false;
  const contextExpanded = contextFolder ? folderAppearance.expandedIds.includes(contextFolder.id) : false;
  const contextAlbum = albumContextMenu ? albums.find((album) => album.id === albumContextMenu.id) : undefined;
  useEffect(() => {
    window.localStorage.setItem(FOLDER_APPEARANCE_KEY, JSON.stringify(folderAppearance));
  }, [folderAppearance]);
  useEffect(() => {
    if (!folderContextMenu && !albumContextMenu) return;
    const close = () => { setFolderContextMenu(null); setAlbumContextMenu(null); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('blur', close); window.removeEventListener('keydown', closeOnEscape); };
  }, [albumContextMenu, folderContextMenu]);
  useEffect(() => {
    if (!folderRemovalCandidate) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !folderRemovalBusy) setFolderRemovalCandidate(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [folderRemovalBusy, folderRemovalCandidate]);
  const renameFolder = async () => {
    if (!folderRenameCandidate || !folderRenameDraft.trim() || folderRenameBusy) return;
    setFolderRenameBusy(true);
    try {
      await window.desktopApi.renameCatalogFolder({ folderId: folderRenameCandidate.id, name: folderRenameDraft.trim() });
      setFolderRenameCandidate(null);
      setFolderActionNotice('文件夹已重命名，原图和图库关系保持不变。');
      await onRefreshAlbums();
    } catch (error) {
      setFolderActionNotice(error instanceof Error && error.message.includes('FOLDER_NAME_ALREADY_EXISTS') ? '重命名失败：同级目录中已存在同名文件夹。' : '重命名失败，请检查文件夹权限。');
    } finally { setFolderRenameBusy(false); }
  };
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
            <button className="section-disclosure" type="button" aria-label={folderAppearance.sectionCollapsed ? '展开关联文件夹区域' : '收起关联文件夹区域'} aria-expanded={!folderAppearance.sectionCollapsed} onClick={() => setFolderAppearance((current) => ({ ...current, sectionCollapsed: !current.sectionCollapsed }))}><ChevronRight size={12} /><span>关联文件夹</span></button>
            <span>{selectedOfflineFolder && <button type="button" aria-label={`重新定位 ${selectedOfflineFolder.name}`} title="重新定位离线文件夹" onClick={() => void onRelinkFolder(selectedOfflineFolder.id)}><RotateCcw size={13} /></button>}<button type="button" aria-label="添加关联文件夹" onClick={() => void onImportFolders()}><Plus size={13} /></button></span>
          </div>
          {!folderAppearance.sectionCollapsed && <div className="folder-tree" role="tree" aria-label="关联文件夹" onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFolderDropTargetId(null); }}>
          {displayedFolders.map((folder, index) => {
            const color = folderAppearance.colors[folder.id] ?? 'none';
            const expanded = folderAppearance.expandedIds.includes(folder.id);
            const hasChildren = (folderChildren.get(folder.id)?.length ?? 0) > 0;
            return <div className={`folder-entry color-${color}`} key={folder.id} role="none">
              {hasChildren ? <button className="folder-disclosure" type="button" aria-label={`${expanded ? '收起' : '展开'} ${folder.name}`} aria-expanded={expanded} style={{ left: 3 + folder.depth * 13 }} onClick={() => setFolderAppearance((current) => ({ ...current, expandedIds: expanded ? current.expandedIds.filter((id) => id !== folder.id) : [...current.expandedIds, folder.id] }))}><ChevronRight size={11} className={expanded ? 'is-expanded' : ''} /></button> : <span className="folder-disclosure-spacer" style={{ width: 18, marginLeft: 3 + folder.depth * 13 }} />}
              <button className={`nav-row folder-row${selectedFolderId === folder.id ? ' is-selected' : ''}${folderDropTargetId === folder.id ? ' is-drop-target' : ''}${draggedFolderId === folder.id ? ' is-dragging' : ''}`} style={{ paddingLeft: 25 + folder.depth * 13 }} type="button" role="treeitem" aria-level={folder.depth + 1} aria-selected={selectedFolderId === folder.id} aria-expanded={hasChildren ? expanded : undefined} tabIndex={selectedFolderId === folder.id || (!selectedFolderId && index === 0) ? 0 : -1} draggable={!isDemo} onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('application/x-photoallisai-folder', folder.id);
                event.dataTransfer.setData('text/plain', folder.name);
                setDraggedFolderId(folder.id);
              }} onDragEnd={() => { setDraggedFolderId(null); setFolderDropTargetId(null); }} onKeyDown={(event) => {
                if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault();
                  const targetIndex = event.key === 'Home' ? 0 : event.key === 'End' ? displayedFolders.length - 1 : Math.max(0, Math.min(displayedFolders.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
                  const target = displayedFolders[targetIndex];
                  if (target) { onSelectFolder(target.id); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-folder-id="${CSS.escape(target.id)}"]`)?.focus()); }
                } else if (event.key === 'ArrowRight' && hasChildren && !expanded) {
                  event.preventDefault();
                  setFolderAppearance((current) => ({ ...current, expandedIds: [...current.expandedIds, folder.id] }));
                } else if (event.key === 'ArrowRight' && hasChildren && expanded) {
                  event.preventDefault();
                  const child = displayedFolders[index + 1];
                  if (child?.parentId === folder.id) { onSelectFolder(child.id); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-folder-id="${CSS.escape(child.id)}"]`)?.focus()); }
                } else if (event.key === 'ArrowLeft') {
                  event.preventDefault();
                  if (expanded) setFolderAppearance((current) => ({ ...current, expandedIds: current.expandedIds.filter((id) => id !== folder.id) }));
                  else if (folder.parentId) { const parent = visibleFolders.find((item) => item.id === folder.parentId); if (parent) { onSelectFolder(parent.id); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-folder-id="${CSS.escape(parent.id)}"]`)?.focus()); } }
                } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectFolder(folder.id); }
              }} data-folder-id={folder.id} onClick={() => onSelectFolder(folder.id)} onDragOver={(event) => {
                const types = Array.from(event.dataTransfer.types);
                if (isDemo || !types.some((type) => type === 'application/x-photoallisai-assets' || type === 'application/x-photoallisai-folder')) return;
                event.preventDefault();
                folderDropCopies.current = event.ctrlKey || event.metaKey || event.altKey;
                event.dataTransfer.dropEffect = types.includes('application/x-photoallisai-folder') ? 'move' : folderDropCopies.current ? 'copy' : 'move';
                setFolderDropTargetId(folder.id);
              }} onDrop={(event) => {
                if (isDemo) return;
                const sourceFolderId = event.dataTransfer.getData('application/x-photoallisai-folder');
                if (sourceFolderId) {
                  event.preventDefault();
                  event.stopPropagation();
                  setFolderDropTargetId(null);
                  setDraggedFolderId(null);
                  if (sourceFolderId === folder.id) { setFolderActionNotice('不能把文件夹移动到自身。'); return; }
                  void onMoveFolder(sourceFolderId, folder.id).then((moved) => {
                    setFolderAppearance((current) => ({ ...current, expandedIds: [...new Set([...current.expandedIds, folder.id])] }));
                    onSelectFolder(moved.id);
                    setFolderActionNotice(`已将文件夹移入「${folder.name}」。`);
                  }).catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    setFolderActionNotice(message.includes('DESKTOP_API_OUTDATED') ? '当前应用窗口仍在使用旧版本，请完全退出并重新启动应用后再移动文件夹。' : message.includes('FOLDER_MOVE_INTO_SELF') ? '不能把文件夹移动到自身。' : message.includes('FOLDER_MOVE_INTO_DESCENDANT') ? '不能把文件夹移动到它自己的子目录。' : message.includes('FOLDER_ALREADY_IN_TARGET') ? '文件夹已经位于该目录中。' : message.includes('FOLDER_NAME_ALREADY_EXISTS') ? '目标位置已有同名文件夹。' : message.includes('CATALOG_FOLDER_NOT_FOUND') || message.includes('ENOENT') ? '目录状态已变化，请刷新图库后重试。' : message.includes('EACCES') || message.includes('EPERM') ? '移动文件夹被系统拒绝，请检查目标目录权限。' : message.includes('EXDEV') ? '源目录和目标目录不在同一磁盘，暂不支持直接移动。' : `移动文件夹失败：${message.replace(/^Error invoking remote method [^:]+: /u, '').slice(0, 120)}`);
                  });
                  return;
                }
                if (!onDropAssets) return;
                const raw = event.dataTransfer.getData('application/x-photoallisai-assets');
                if (!raw) return;
                event.preventDefault();
                event.stopPropagation();
                setFolderDropTargetId(null);
                try {
                  const assetIds = JSON.parse(raw) as unknown;
                  const copy = folderDropCopies.current || event.ctrlKey || event.metaKey || event.altKey;
                  folderDropCopies.current = false;
                  if (Array.isArray(assetIds) && assetIds.length > 0 && assetIds.every((id) => typeof id === 'string')) void onDropAssets(folder.id, assetIds, copy);
                } catch { setFolderActionNotice('无法识别拖入的照片，请重试或使用“移动到文件夹”菜单。'); }
              }} onDragEnter={(event) => { if (Array.from(event.dataTransfer.types).some((type) => type === 'application/x-photoallisai-assets' || type === 'application/x-photoallisai-folder')) setFolderDropTargetId(folder.id); }} onContextMenu={(event) => { event.preventDefault(); setFolderContextMenu({ id: folder.id, x: event.clientX, y: event.clientY }); }}>
                <Folder size={15} />
                <span>{folder.name}</span>
                <span className="row-count">{folder.offlineCount > 0 ? `离线 ${folder.offlineCount}` : folder.assetCount}</span>
              </button>
            </div>;
          })}
          </div>}
          {folderContextMenu && contextFolder && <div className="folder-context-menu" role="menu" aria-label={`文件夹菜单 ${contextFolder.name}`} style={{ left: Math.min(folderContextMenu.x, Math.max(8, window.innerWidth - 224)), top: Math.min(folderContextMenu.y, Math.max(8, window.innerHeight - 286)) }} onPointerDown={(event) => event.stopPropagation()}>
            <div className="folder-menu-title"><Folder size={14} /><span>{contextFolder.name}</span></div>
            <button type="button" role="menuitem" onClick={() => { onSelectFolder(contextFolder.id); setFolderContextMenu(null); }}><GalleryHorizontalEnd size={14} /><span>在图库中显示</span></button>
            <button type="button" role="menuitem" onClick={() => { setFolderRenameCandidate(contextFolder); setFolderRenameDraft(contextFolder.name); setFolderContextMenu(null); }}><FilePenLine size={14} /><span>重命名文件夹…</span></button>
            <button type="button" role="menuitem" disabled={isDemo || folderActionBusy} onClick={async () => { setFolderActionBusy(true); try { const revealed = await onRevealFolder(contextFolder.id); setFolderActionNotice(revealed ? '已在文件管理器中显示文件夹。' : '文件夹当前不可访问。'); } catch { setFolderActionNotice('无法打开文件管理器，请检查文件夹权限或磁盘连接。'); } finally { setFolderActionBusy(false); setFolderContextMenu(null); } }}><FolderOpen size={14} /><span>{FILE_MANAGER_LABEL}</span></button>
            <button type="button" role="menuitem" disabled={isDemo || folderActionBusy} onClick={async () => { setFolderActionBusy(true); try { const report = await onSynchronizeFolder(contextFolder.id); setFolderActionNotice(`同步完成：新增 ${report.discovered} 张，离线 ${report.offline} 张。`); } catch { setFolderActionNotice('同步失败，请检查文件夹权限或磁盘连接。'); } finally { setFolderActionBusy(false); setFolderContextMenu(null); } }}><RefreshCw size={14} /><span>同步文件夹</span></button>
            {contextHasChildren && <button type="button" role="menuitem" onClick={() => { setFolderAppearance((current) => ({ ...current, expandedIds: contextExpanded ? current.expandedIds.filter((id) => id !== contextFolder.id) : [...current.expandedIds, contextFolder.id] })); setFolderContextMenu(null); }}><ChevronRight className={contextExpanded ? 'is-expanded' : ''} size={14} /><span>{contextExpanded ? '收起子文件夹' : '展开子文件夹'}</span></button>}
            {contextFolder.isRoot && <><span className="folder-menu-separator" /><button type="button" role="menuitem" disabled={isDemo || folderActionBusy} onClick={() => { void onRelinkFolder(contextFolder.id); setFolderContextMenu(null); }}><RotateCcw size={14} /><span>更新关联路径…</span></button><button className="is-danger" type="button" role="menuitem" disabled={isDemo || folderActionBusy} onClick={() => { setFolderRemovalError(''); setFolderRemovalCandidate(contextFolder); setFolderContextMenu(null); }}><FolderMinus size={14} /><span>取消关联…</span></button></>}
            <span className="folder-menu-separator" />
            <strong>文件夹颜色</strong><div className="folder-color-dots">{FOLDER_COLORS.map((option) => <button className={`color-${option}${(folderAppearance.colors[folderContextMenu.id] ?? 'none') === option ? ' is-active' : ''}`} type="button" role="menuitem" aria-label={option === 'none' ? '无颜色' : `${option} 色`} key={option} onClick={() => { setFolderAppearance((current) => ({ ...current, colors: { ...current.colors, [folderContextMenu.id]: option } })); setFolderContextMenu(null); }}><span />{(folderAppearance.colors[folderContextMenu.id] ?? 'none') === option && <Check size={10} />}</button>)}</div>
          </div>}
        </div>

        {!isDemo && <div className="sidebar-section"><div className="section-heading"><span>相册</span><button type="button" aria-label="新建相册" onClick={() => { setAlbumManagerOpen(true); setEditingAlbumId(null); setAlbumName(''); }}><Plus size={13} /></button></div>{albums.length === 0 ? <small className="sidebar-empty">暂无相册</small> : albums.map((album) => <button className={`nav-row folder-row${selectedAlbumId === album.id ? ' is-selected' : ''}`} type="button" key={album.id} onClick={() => onSelectAlbum(selectedAlbumId === album.id ? null : album.id)} onContextMenu={(event) => { event.preventDefault(); setFolderContextMenu(null); setAlbumContextMenu({ id: album.id, x: event.clientX, y: event.clientY }); }}><FolderHeart size={15} /><span>{album.name}</span><span className="row-count">{album.assetCount}</span></button>)}</div>}
        {albumContextMenu && contextAlbum && <div className="folder-context-menu album-context-menu" role="menu" aria-label={`相册菜单 ${contextAlbum.name}`} style={{ left: Math.min(albumContextMenu.x, Math.max(8, window.innerWidth - 224)), top: Math.min(albumContextMenu.y, Math.max(8, window.innerHeight - 150)) }} onPointerDown={(event) => event.stopPropagation()}>
          <div className="folder-menu-title"><FolderHeart size={14} /><span>{contextAlbum.name}</span></div>
          <button type="button" role="menuitem" onClick={() => { onSelectAlbum(contextAlbum.id); setAlbumContextMenu(null); }}><GalleryHorizontalEnd size={14} /><span>在图库中显示</span></button>
          <button type="button" role="menuitem" onClick={() => { setEditingAlbumId(contextAlbum.id); setAlbumName(contextAlbum.name); setAlbumManagerOpen(true); setAlbumContextMenu(null); }}><FilePenLine size={14} /><span>重命名相册…</span></button>
          <span className="folder-menu-separator" />
          <button className="is-danger" type="button" role="menuitem" onClick={() => { setAlbumDeleteCandidate(contextAlbum); setAlbumContextMenu(null); }}><Trash2 size={14} /><span>删除相册…</span></button>
        </div>}

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
      {folderRemovalCandidate && <div className="modal-backdrop sidebar-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !folderRemovalBusy) setFolderRemovalCandidate(null); }}><section className="removal-dialog" role="alertdialog" aria-modal="true" aria-labelledby="folder-removal-title" aria-describedby="folder-removal-description"><header><span className="dialog-icon"><FolderMinus size={17} /></span><div><h2 id="folder-removal-title">取消关联「{folderRemovalCandidate.name}」？</h2><p id="folder-removal-description">只会从本图库移除该路径的关联，不会删除、移动或修改磁盘上的任何文件。</p></div></header><div className="removal-impact"><Info size={15} /><span>其中 {folderRemovalCandidate.assetCount} 张照片会从图库和搜索结果中隐藏。AI 分析、生成版本、评分、标签和相册关系都会保留，重新关联同一路径后自动恢复。</span></div>{folderRemovalError && <div className="folder-removal-error" role="alert"><CircleAlert size={14} /><span>{folderRemovalError}</span></div>}<footer><button autoFocus className="quiet-button" type="button" disabled={folderRemovalBusy} onClick={() => setFolderRemovalCandidate(null)}>取消</button><button className="primary-action compact" type="button" disabled={folderRemovalBusy} onClick={async () => { setFolderRemovalBusy(true); setFolderRemovalError(''); try { await onUnregisterFolder(folderRemovalCandidate.id); setFolderRemovalCandidate(null); } catch (error) { const message = error instanceof Error ? error.message : String(error); setFolderRemovalError(message.includes('FOLDER_HAS_ACTIVE_TASKS') ? '此文件夹仍有正在运行或等待中的 AI 任务，请先取消或完成任务。' : message.includes('FOLDER_HAS_ACTIVE_FILE_OPERATIONS') ? '此文件夹仍有未完成的文件操作，请等待操作完成或恢复后重试。' : '无法移除此关联文件夹。请刷新图库后重试。'); } finally { setFolderRemovalBusy(false); } }}>{folderRemovalBusy ? '正在取消关联…' : '取消关联'}</button></footer></section></div>}
      {folderRenameCandidate && <div className="modal-backdrop sidebar-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !folderRenameBusy) setFolderRenameCandidate(null); }}><form className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="folder-rename-title" onSubmit={(event) => { event.preventDefault(); void renameFolder(); }}><header><div><span className="dialog-icon"><Folder size={16} /></span><div><h2 id="folder-rename-title">重命名文件夹</h2><p>会同步更新磁盘目录和图库路径，不会影响照片元数据。</p></div></div><IconButton label="关闭文件夹重命名窗口" disabled={folderRenameBusy} onClick={() => setFolderRenameCandidate(null)}><X size={15} /></IconButton></header><label className="rename-field"><span>文件夹名称</span><input autoFocus value={folderRenameDraft} onChange={(event) => setFolderRenameDraft(event.target.value)} spellCheck={false} /></label><footer><span>不能包含路径分隔符，也不能与同级目录重名。</span><div><button className="quiet-button" type="button" disabled={folderRenameBusy} onClick={() => setFolderRenameCandidate(null)}>取消</button><button className="primary-action compact" type="submit" disabled={!folderRenameDraft.trim() || folderRenameBusy}>{folderRenameBusy ? '正在重命名…' : '重命名'}</button></div></footer></form></div>}
      {albumDeleteCandidate && <div className="modal-backdrop sidebar-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !albumBusy) setAlbumDeleteCandidate(null); }}><section className="removal-dialog" role="alertdialog" aria-modal="true" aria-labelledby="album-removal-title"><header><span className="dialog-icon"><Trash2 size={17} /></span><div><h2 id="album-removal-title">删除相册「{albumDeleteCandidate.name}」？</h2><p>只删除相册及其照片关系，不会删除或移动任何原图和 AI 生成版本。</p></div></header><div className="removal-impact"><Info size={15} /><span>相册内的 {albumDeleteCandidate.assetCount} 张照片仍会保留在图库和原文件夹中。</span></div><footer><button autoFocus className="quiet-button" type="button" disabled={albumBusy} onClick={() => setAlbumDeleteCandidate(null)}>取消</button><button className="danger-action" type="button" disabled={albumBusy} onClick={async () => { setAlbumBusy(true); try { await window.desktopApi.deleteCatalogAlbum(albumDeleteCandidate.id); if (selectedAlbumId === albumDeleteCandidate.id) onSelectAlbum(null); await onRefreshAlbums(); setAlbumDeleteCandidate(null); } finally { setAlbumBusy(false); } }}>{albumBusy ? '正在删除…' : '删除相册'}</button></footer></section></div>}
      {folderActionNotice && <div className="operation-toast" role="status">{folderActionNotice}<button type="button" aria-label="关闭文件夹提示" onClick={() => setFolderActionNotice('')}><X size={13} /></button></div>}
    </aside>
  );
}

function Filmstrip({
  items,
  selected,
  selection,
  onSelect,
  onSelectionChange,
  onFocusPhoto,
  collectionName,
  toolbarHost,
  totalCount,
  favoriteOnly,
  onFavoriteOnlyChange,
  sortBy,
  onSortByChange,
  hasMore,
  loading,
  onLoadMore,
  onOpenContextMenu
}: {
  items: Photo[];
  selected: Photo;
  selection: SelectionState;
  onSelect: (photo: Photo, intent: SelectionIntent) => void;
  onSelectionChange: React.Dispatch<React.SetStateAction<SelectionState>>;
  onFocusPhoto: (photo: Photo) => void;
  collectionName: string;
  toolbarHost: HTMLDivElement | null;
  totalCount: number;
  favoriteOnly: boolean;
  onFavoriteOnlyChange: (value: boolean) => void;
  sortBy: CatalogSort;
  onSortByChange: (value: CatalogSort) => void;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  onOpenContextMenu: (event: React.MouseEvent, photo: Photo) => void;
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, scrollLeft: 0 });

  const [viewMode, setViewMode] = useState<'filmstrip' | 'grid'>('filmstrip');
  const itemSize = 137;
  const virtual = computeHorizontalWindow(items.length, itemSize, viewport.width, viewport.scrollLeft, 4);
  const visibleItems = items.slice(virtual.start, virtual.end);

  useEffect(() => {
    const selectPhotos = (event: Event) => {
      if (event.target === viewportRef.current) onSelectionChange(selectAll(items.map((photo) => photo.id)));
    };
    window.addEventListener('photoallisai:select-all-photos', selectPhotos);
    return () => window.removeEventListener('photoallisai:select-all-photos', selectPhotos);
  }, [items, onSelectionChange]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const updateWidth = () => setViewport((current) => ({ ...current, width: element.clientWidth }));
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    const index = items.findIndex((photo) => photo.id === selected.id);
    if (!element || index < 0) return;
    if (viewMode === 'filmstrip') {
      const left = index * itemSize;
      if (left < element.scrollLeft || left + itemSize > element.scrollLeft + element.clientWidth) {
        element.scrollTo({ left: Math.max(0, left - (element.clientWidth - itemSize) / 2), behavior: 'smooth' });
      }
    } else {
      window.setTimeout(() => element.querySelector<HTMLElement>(`[data-asset-id="${selected.id}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
    }
  }, [items, selected.id, viewMode]);

  return (
    <section className="filmstrip-region">
      {toolbarHost && createPortal(<div className="filmstrip-toolbar">
        <span className="filmstrip-count" title={collectionName}>{totalCount} 张</span>
        <div className="filmstrip-tools">
          <IconButton label="仅显示首选照片" active={favoriteOnly} pressed={favoriteOnly} onClick={() => onFavoriteOnlyChange(!favoriteOnly)}><ListFilter size={14} /></IconButton>
          <label className="sort-control"><select aria-label="图库排序" value={sortBy} onChange={(event) => onSortByChange(event.target.value as CatalogSort)}><option value="modifiedAt">拍摄时间</option><option value="fileName">文件名</option><option value="rating">评分</option></select><ChevronDown size={12} /></label>
          <div className="segmented-control">
            <button className={viewMode === 'filmstrip' ? 'is-active' : ''} type="button" aria-label="胶片视图" aria-pressed={viewMode === 'filmstrip'} onClick={() => setViewMode('filmstrip')}><GalleryHorizontalEnd size={14} /></button>
            <button className={viewMode === 'grid' ? 'is-active' : ''} type="button" aria-label="网格视图" aria-pressed={viewMode === 'grid'} onClick={() => setViewMode('grid')}><Grid2X2 size={14} /></button>
          </div>
        </div>
      </div>, toolbarHost)}
      <div className={`filmstrip${viewMode === 'grid' ? ' is-grid' : ''}`} role="listbox" aria-label="照片" aria-multiselectable="true" tabIndex={0} ref={viewportRef} onKeyDown={(event) => {
        const focusIndex = Math.max(0, items.findIndex((photo) => photo.id === (selection.focusId ?? selected.id)));
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
          event.preventDefault();
          onSelectionChange(selectAll(items.map((photo) => photo.id)));
          return;
        }
        if ((event.metaKey || event.ctrlKey) && event.code === 'Space') {
          event.preventDefault();
          const photo = items[focusIndex];
          if (photo) onSelectionChange((current) => updateSelection(current, items.map((item) => item.id), photo.id, 'toggle'));
          return;
        }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || items.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const columns = viewMode === 'grid' ? Math.max(1, Math.floor((viewportRef.current?.clientWidth ?? itemSize) / itemSize)) : 1;
        const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -columns : columns;
        const nextPhoto = items[clamp(focusIndex + delta, 0, items.length - 1)]!;
        if (event.metaKey || event.ctrlKey) {
          onSelectionChange((current) => ({ ...current, focusId: nextPhoto.id }));
        } else {
          onSelect(nextPhoto, event.shiftKey ? 'range' : 'replace');
        }
        onFocusPhoto(nextPhoto);
        window.setTimeout(() => viewportRef.current?.querySelector<HTMLElement>(`[data-asset-id="${nextPhoto.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }), 0);
      }} onScroll={(event) => {
        const element = event.currentTarget;
        setViewport((current) => ({ ...current, scrollLeft: element.scrollLeft }));
        if (hasMore && !loading && (viewMode === 'grid' ? element.scrollTop + element.clientHeight >= element.scrollHeight - 220 : element.scrollLeft + element.clientWidth >= element.scrollWidth - itemSize * 3)) onLoadMore();
      }}>
        <div className="filmstrip-track" style={viewMode === 'grid' ? undefined : { width: virtual.totalSize + (hasMore ? itemSize : 0) }}>
        {(viewMode === 'grid' ? items : visibleItems).map((photo, visibleIndex) => {
          const index = viewMode === 'grid' ? visibleIndex : virtual.start + visibleIndex;
          return (
          <button
            className={`thumb${selected.id === photo.id ? ' is-selected' : ''}${selection.selectedIds.has(photo.id) ? ' is-chosen' : ''}${photo.offline ? ' is-offline' : ''}`}
            key={photo.id}
            data-asset-id={photo.id}
            style={viewMode === 'grid' ? undefined : { left: index * itemSize }}
            onClick={(event) => onSelect(
              photo,
              event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'replace'
            )}
            onContextMenu={(event) => onOpenContextMenu(event, photo)}
            draggable
            aria-grabbed={selection.selectedIds.has(photo.id)}
            onDragStart={(event) => { preparePhotoDrag(event, photo, selection); }}
            role="option"
            aria-selected={selection.selectedIds.has(photo.id)}
            type="button"
          >
            <span className="raw-placeholder"><Image size={22} /><small>{photo.format}</small></span>
            {photo.thumbnailSrc || photo.src ? <CatalogImage src={photo.thumbnailSrc ?? photo.src} /> : null}
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
  onRegenerate,
  onReview,
  onRevealResult,
  onOpenContextMenu,
  onClose,
  initialResultId,
  onToolbarHostChange
}: {
  photo: Photo;
  results: GenerationResult[];
  isDemo: boolean;
  exportPresets: ExportPreset[];
  selectedExportPresetId: string | null;
  trackedExportNotice: string;
  onExportPresetChange: (presetId: string | null) => void;
  onExport: (resultIds: string[], presetId?: string | null) => Promise<string>;
  onRegenerate: (result: GenerationResult) => Promise<string>;
  onReview: (resultId: string, reviewState: GenerationResult['reviewState']) => Promise<void>;
  onRevealResult: (resultId: string) => void;
  onOpenContextMenu: (event: React.MouseEvent) => void;
  onClose?: (() => void) | undefined;
  initialResultId?: string | null | undefined;
  onToolbarHostChange: (element: HTMLDivElement | null) => void;
}): React.JSX.Element {
  const [compareMode, setCompareMode] = useState<CompareMode>('single');
  const [split, setSplit] = useState(52);
  const [showOriginal, setShowOriginal] = useState(false);
  const [selectedResultId, setSelectedResultId] = useState<string | null>(results[0]?.id ?? null);
  const [exportNotice, setExportNotice] = useState('');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panOriginRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const wheelEndTimerRef = useRef<number | undefined>(undefined);
  const [imageAspectRatio, setImageAspectRatio] = useState(() => photo.src ? IMAGE_ASPECT_RATIOS.get(photo.src) ?? 3 / 2 : 3 / 2);
  const [fittedSize, setFittedSize] = useState({ width: 0, height: 0 });
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const latestResultId = results[0]?.id ?? null;
  const initialSelectionId = initialResultId === undefined ? latestResultId : results.find((result) => result.id === initialResultId)?.id ?? null;
  const selectedResult = selectedResultId ? results.find((result) => result.id === selectedResultId) : undefined;
  const generatedSource = isDemo ? photo.src : selectedResult?.resultUrl;

  useEffect(() => {
    setSelectedResultId(initialSelectionId);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    if (photo.src) setImageAspectRatio(IMAGE_ASPECT_RATIOS.get(photo.src) ?? 3 / 2);
  }, [photo.id, photo.src, initialSelectionId]);

  useLayoutEffect(() => {
    const container = canvasWrapRef.current;
    if (!container) return;
    const fit = () => {
      const availableWidth = Math.max(1, container.clientWidth);
      const availableHeight = Math.max(1, container.clientHeight);
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
      if (!(target instanceof Element) || target.closest('input, textarea, select, [contenteditable="true"]') || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === 'o') setShowOriginal(event.type === 'keydown');
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);

  useEffect(() => {
    const onMenuCommand = (event: Event) => {
      const command = (event as CustomEvent<MenuCommand>).detail;
      if (command === 'fit-image' || command === 'zoom-100') {
        setZoom(1);
        setPan({ x: 0, y: 0 });
      } else if (command === 'toggle-original') {
        setShowOriginal((current) => !current);
      }
    };
    window.addEventListener('photoallisai:menu-command', onMenuCommand);
    return () => window.removeEventListener('photoallisai:menu-command', onMenuCommand);
  }, []);

  useEffect(() => () => {
    if (wheelEndTimerRef.current !== undefined) window.clearTimeout(wheelEndTimerRef.current);
  }, []);

  const adjustZoom = (factor: number) => {
    setZoom((current) => {
      const next = Math.min(4, Math.max(0.25, Math.round(current * factor * 100) / 100));
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };
  const constrainPan = useCallback((nextPan: { x: number; y: number }, nextZoom: number) => {
    const container = canvasWrapRef.current;
    if (!container || nextZoom <= 1) return { x: 0, y: 0 };
    const maxX = Math.max(0, (fittedSize.width * nextZoom - Math.max(1, container.clientWidth)) / 2);
    const maxY = Math.max(0, (fittedSize.height * nextZoom - Math.max(1, container.clientHeight)) / 2);
    return { x: clamp(nextPan.x, -maxX, maxX), y: clamp(nextPan.y, -maxY, maxY) };
  }, [fittedSize.height, fittedSize.width]);
  const captureAspectRatio = useCallback((image: HTMLImageElement) => {
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      setImageAspectRatio(image.naturalWidth / image.naturalHeight);
    }
  }, []);

  return (
    <section className="viewer">

      <div className={`canvas-wrap${zoom > 1 ? ' is-zoomed' : ''}`} tabIndex={0} ref={canvasWrapRef} onContextMenu={onOpenContextMenu} onWheel={(event) => {
        const container = event.currentTarget;
        container.classList.add('is-gesturing');
        if (wheelEndTimerRef.current !== undefined) window.clearTimeout(wheelEndTimerRef.current);
        wheelEndTimerRef.current = window.setTimeout(() => container.classList.remove('is-gesturing'), 90);
        if (event.ctrlKey || event.metaKey || event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
          event.preventDefault();
          const rect = container.getBoundingClientRect();
          const pointer = { x: event.clientX - (rect.left + rect.width / 2), y: event.clientY - (rect.top + rect.height / 2) };
          const normalizedDelta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 80 : 1);
          setZoom((current) => {
            const next = clamp(current * Math.exp(-normalizedDelta * 0.0025), 0.25, 4);
            const ratio = next / current;
            setPan((currentPan) => constrainPan({ x: pointer.x - (pointer.x - currentPan.x) * ratio, y: pointer.y - (pointer.y - currentPan.y) * ratio }, next));
            return next;
          });
        } else if (zoom > 1) {
          event.preventDefault();
          setPan((current) => constrainPan({ x: current.x - event.deltaX, y: current.y - event.deltaY }, zoom));
        }
      }} onPointerDown={(event) => {
        if (event.button === 0) event.currentTarget.focus({ preventScroll: true });
        if (zoom <= 1 || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        panOriginRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
        event.currentTarget.classList.add('is-panning');
      }} onPointerMove={(event) => {
        const origin = panOriginRef.current;
        if (!origin) return;
        setPan(constrainPan({ x: origin.panX + event.clientX - origin.x, y: origin.panY + event.clientY - origin.y }, zoom));
      }} onPointerUp={(event) => {
        panOriginRef.current = null;
        event.currentTarget.classList.remove('is-panning');
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }} onPointerCancel={(event) => {
        panOriginRef.current = null;
        event.currentTarget.classList.remove('is-panning');
      }}>
        <div className="viewer-title">
          {onClose && <IconButton label="关闭看图" onClick={onClose}><ChevronLeft size={16} /></IconButton>}
          <span title={photo.fileName}>{photo.fileName}</span>
          <i>{selectedResult ? `生成版本 ${selectedResult.version}` : isDemo ? '生成版本 2' : '原图'}</i>
        </div>
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
              <BufferedPreviewImage className="generated-image" src={generatedSource} alt="AI 生成版本" onReady={(image) => { if (!photo.src) captureAspectRatio(image); }} />
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
      <ViewerToolbar>
        <div className="viewer-actions" data-tool-group="compare">
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
        </div>
        <div className="viewer-actions" data-tool-group="zoom">
          <IconButton label="缩小" disabled={zoom <= 0.25} onClick={() => adjustZoom(0.8)}><ZoomOut size={15} /></IconButton>
          <span className="zoom-value" aria-live="polite">{Math.round(zoom * 100)}%</span>
          <IconButton label="放大" disabled={zoom >= 4} onClick={() => adjustZoom(1.25)}><ZoomIn size={15} /></IconButton>
          <IconButton label="适应窗口" active={zoom === 1} pressed={zoom === 1} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}><Maximize2 size={15} /></IconButton>
        </div>
        <div className="viewer-actions" data-tool-group="review">
          {selectedResult && !isDemo && <span className="review-actions"><button type="button" aria-label="接受当前版本" className={selectedResult.reviewState === 'accepted' ? 'is-review-active' : ''} onClick={() => void onReview(selectedResult.id, 'accepted')}>接受</button><button type="button" aria-label="标记为首选" className={selectedResult.reviewState === 'preferred' ? 'is-review-active' : ''} onClick={() => void onReview(selectedResult.id, 'preferred')}><Star size={12} />首选</button><button type="button" aria-label="拒绝当前版本" className={selectedResult.reviewState === 'rejected' ? 'is-review-rejected' : ''} onClick={() => void onReview(selectedResult.id, 'rejected')}>拒绝</button></span>}
        </div>
        <div className="version-switcher" data-tool-group="versions">
          <button className={!selectedResult && !isDemo ? 'is-current' : ''} type="button" title="按住 O 键可临时查看原图" onClick={() => setSelectedResultId(null)}>原图</button>
          {isDemo ? <><button type="button">V1</button><button className="is-current" type="button">V2</button></> : [...results].reverse().map((result) => (
            <button className={`version-button${selectedResult?.id === result.id ? ' is-current' : ''}${result.reviewState === 'preferred' ? ' is-preferred' : result.reviewState === 'rejected' ? ' is-rejected' : ''}`} type="button" key={result.id} onClick={() => setSelectedResultId(result.id)} title={result.reviewState === 'preferred' ? '首选' : result.reviewState === 'accepted' ? '已接受' : result.reviewState === 'rejected' ? '已拒绝' : '未审阅'}>V{result.version}</button>
          ))}
        </div>
        <div className="version-switcher" data-tool-group="export">
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
        <div className="viewer-library-tools" data-tool-group="library" ref={onToolbarHostChange} />
      </ViewerToolbar>
    </section>
  );
}

function WorkflowCommonSettings({ templates, rules, onRulesChange, templateId, onTemplateChange, onOpenTemplates, showTemplatesButton = false }: { templates: PromptTemplate[]; rules: WorkflowRule[]; onRulesChange: React.Dispatch<React.SetStateAction<WorkflowRule[]>>; templateId: string; onTemplateChange: (id: string) => void; onOpenTemplates: () => void; showTemplatesButton?: boolean }): React.JSX.Element {
  return <section className="inspector-section workflow-inspector-settings">
    <div className="inspector-heading"><span>工作流通用设置</span></div>
    <label className="workflow-field"><span>批次默认模板</span><select aria-label="工作流批次默认模板" value={templateId} onChange={(event) => onTemplateChange(event.target.value)}><option value="">默认分层模板</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
    <div className="workflow-inspector-rule-heading">通用规则</div>
    {rules.map((rule) => <label className="workflow-rule" key={rule.id}><input type="checkbox" checked={rule.enabled} aria-label={`启用 ${rule.text}`} onChange={() => onRulesChange((items) => items.map((item) => item.id === rule.id ? { ...item, enabled: !item.enabled } : item))} /><input aria-label={`编辑规则 ${rule.text}`} value={rule.text} onChange={(event) => onRulesChange((items) => items.map((item) => item.id === rule.id ? { ...item, text: event.target.value } : item))} /></label>)}
    <div className="workflow-inspector-actions"><button className="quiet-button compact" type="button" onClick={() => onRulesChange((items) => [...items, { id: crypto.randomUUID(), text: '', enabled: true }])}><Plus size={12} />添加规则</button>{showTemplatesButton && <button className="quiet-button compact" type="button" onClick={onOpenTemplates}>模板库</button>}</div>
  </section>;
}

function AiPanel({
  photo,
  results,
  trashedResults,
  revision,
  isDemo,
  notice,
  onAnalyze,
  analyzing,
  analysisTaskStatus,
  analysisErrorCode,
  generationProfiles,
  templates,
  onOpenTemplates,
  onGenerate,
  onTrashResult,
  onRestoreResult,
  onAddToWorkflow,
  onOpenBatch,
  workflowQueueCount,
  workflowPosition,
  selectionCount,
  workflowRules,
  onWorkflowRulesChange,
  workflowTemplateId,
  onWorkflowTemplateChange
}: {
  photo: Photo;
  results: GenerationResult[];
  trashedResults: TrashedGenerationResult[];
  revision: AnalysisRevision | undefined;
  isDemo: boolean;
  notice: string;
  onAnalyze: () => void;
  analyzing: boolean;
  analysisTaskStatus: PersistedTask['status'] | undefined;
  analysisErrorCode: string | null;
  generationProfiles: ProviderProfile[];
  templates: PromptTemplate[];
  onOpenTemplates: () => void;
  onGenerate: (input: { providerProfileId: string; template: PromptTemplate | null; count: number; instruction: string; disabledActionIds: Set<string> }) => Promise<string>;
  onTrashResult: (resultId: string) => Promise<void>;
  onRestoreResult: (resultId: string) => Promise<void>;
  onAddToWorkflow: () => void;
  onOpenBatch: () => void;
  workflowQueueCount: number;
  workflowPosition: number | null;
  selectionCount: number;
  workflowRules: WorkflowRule[];
  onWorkflowRulesChange: React.Dispatch<React.SetStateAction<WorkflowRule[]>>;
  workflowTemplateId: string;
  onWorkflowTemplateChange: (id: string) => void;
  onOpenAgent?: () => void;
}): React.JSX.Element {
  const result = revision?.result;
  const analysisQueued = analysisTaskStatus === 'queued' || analysisTaskStatus === 'paused';
  const analysisRunning = analysisTaskStatus !== undefined && ['preparing', 'uploading', 'processing', 'downloading', 'saving'].includes(analysisTaskStatus);
  const analysisSyncing = analysisTaskStatus === 'completed' && !result;
  const analysisPending = analysisQueued || analysisRunning || analysisSyncing;
  const score = isDemo ? 86 : result ? Math.round(result.quality.overallScore) : '--';
  const summary = isDemo ? '自然光人像' : result?.summary ?? (analysisRunning ? '正在视觉分析' : analysisQueued ? '已加入分析队列' : analysisSyncing ? '正在载入分析结果' : analysisTaskStatus === 'failed' ? '视觉分析失败' : '等待视觉分析');
  const description = isDemo ? '主体清晰，背景存在干扰元素' : result?.catalog.shortDescription;

  return (
    <div className="ai-panel-content">
        <header className="ai-selection-scope"><span>{selectionCount > 1 ? '当前选择' : '当前图片'}</span><strong>{selectionCount > 1 ? `${selectionCount} 张图片` : photo.fileName}</strong></header>
        <section className="ai-purpose-card" aria-label="视觉分析">
        <header className="ai-purpose-heading"><Search size={15} /><strong>视觉分析</strong><span>识别与建议</span></header>
        {selectionCount > 1 && <p className="ai-current-preview">当前查看：{photo.fileName}</p>}
        <div className="analysis-head">
          <div className="analysis-score"><span>AI</span><strong>{score}</strong></div>
          <div className="analysis-head-content"><strong>{summary}</strong>{description && <p>{description}</p>}</div>
          <span className="confidence">{isDemo ? '分析完成' : analysisRunning ? '分析中' : analysisQueued ? '队列中' : analysisSyncing ? '同步中' : analysisTaskStatus === 'failed' ? '失败' : result ? '分析完成' : '未分析'}</span>
          {!isDemo && <div className="analysis-head-actions"><button className="analysis-primary-action" type="button" onClick={onAnalyze} disabled={analyzing || (selectionCount === 1 && analysisPending)}>{analyzing ? '正在提交…' : selectionCount > 1 ? `分析选中的 ${selectionCount} 张` : analysisRunning ? '正在分析' : analysisQueued ? '等待分析' : analysisSyncing ? '正在同步' : result ? '重新分析本图' : '分析本图'}</button></div>}
          {!isDemo && notice && <p className="analysis-notice" aria-live="polite">{notice}</p>}
          {!isDemo && analysisTaskStatus === 'failed' && <AnalysisFailure code={analysisErrorCode} />}
        </div>

        {(isDemo || result) && <div className="inspector-section">
          <div className="inspector-heading"><span>本图分析结果</span><span className="ai-result-file" title={photo.fileName}>{photo.fileName}</span></div>
          <p className="analysis-copy">{isDemo ? '柔和侧光塑造了自然肤色。建议保留浅景深和发丝细节，同时清理右后方路人并轻微提亮面部。' : result?.report}</p>
          {isDemo ? <><div className="issue-row"><i className="severity high" /><span>背景路人分散注意力</span><em>严重</em></div><div className="issue-row"><i className="severity medium" /><span>面部中间调略暗</span><em>中等</em></div></> : result?.quality.issues.map((issue) => <div className="issue-row" key={`${issue.type}-${issue.description}`}><i className={`severity ${issue.severity >= 0.7 ? 'high' : 'medium'}`} /><span>{issue.description}</span><em>{Math.round(issue.confidence * 100)}%</em></div>)}
        </div>}
        </section>
        <section className="ai-purpose-card ai-batch-destination" aria-label="批量修图">
          <header className="ai-purpose-heading"><Image size={15} /><strong>批量修图</strong><span>{workflowQueueCount} 张图片</span></header>
          <button className="secondary-action compact" type="button" onClick={onAddToWorkflow}><Plus size={14} />{selectionCount > 1 ? `添加选中的 ${selectionCount} 张到批量修图` : '添加本图到批量修图'}</button>
          <button className="quiet-button compact" type="button" onClick={onOpenBatch}>打开批量修图<ChevronRight size={13} /></button>
          {workflowPosition !== null && <small>本图已在修图列表中</small>}
        </section>
    </div>
  );
}

function GlobalAiPanel({
  photo,
  selectedIds,
  isDemo,
  workspaceTab,
  onOpenTemplates,
  onAddAssetsToWorkflow,
  onOpenBatch,
  workflowAssetIds,
  tasks,
  workflowRules,
  onWorkflowRulesChange,
  workflowTemplateId,
  onWorkflowTemplateChange,
  onOpenAgent
}: {
  photo: Photo | undefined;
  selectedIds: ReadonlySet<string>;
  isDemo: boolean;
  workspaceTab: WorkspaceTab;
  onOpenTemplates: () => void;
  onAddAssetsToWorkflow: (ids: string[]) => void;
  onOpenBatch: () => void;
  workflowAssetIds: string[];
  tasks: PersistedTask[];
  workflowRules: WorkflowRule[];
  onWorkflowRulesChange: React.Dispatch<React.SetStateAction<WorkflowRule[]>>;
  workflowTemplateId: string;
  onWorkflowTemplateChange: (id: string) => void;
  onOpenAgent?: () => void;
}): React.JSX.Element {
  const [revision, setRevision] = useState<AnalysisRevision>();
  const [results, setResults] = useState<GenerationResult[]>([]);
  const [trashedResults, setTrashedResults] = useState<TrashedGenerationResult[]>([]);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [storageMode, setStorageMode] = useState<AppSettings['generationStorageMode']>('managed');
  const [notice, setNotice] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => { setNotice(''); }, [photo?.id]);

  useEffect(() => {
    if (isDemo) return;
    let active = true;
    void Promise.all([
      window.desktopApi.listProviderProfiles(),
      window.desktopApi.listPromptTemplates(),
      window.desktopApi.getAppSettings()
    ]).then(([nextProfiles, nextTemplates, settings]) => {
      if (!active) return;
      setProfiles(nextProfiles);
      setTemplates(nextTemplates);
      setStorageMode(settings.generationStorageMode);
    });
    return () => { active = false; };
  }, [isDemo, workspaceTab]);

  useEffect(() => {
    if (isDemo || !photo) {
      setRevision(undefined);
      setResults([]);
      setTrashedResults([]);
      return;
    }
    let active = true;
    const refresh = () => {
      void Promise.all([
        window.desktopApi.listAnalysisRevisions(photo.id),
        window.desktopApi.listGenerationResults(photo.id),
        window.desktopApi.listTrashedGenerationResults(photo.id)
      ]).then(([revisions, nextResults, nextTrashed]) => {
        if (!active) return;
        setRevision(revisions[0]);
        setResults(nextResults);
        setTrashedResults(nextTrashed);
      });
    };
    refresh();
    const interval = window.setInterval(refresh, 1_500);
    return () => { active = false; window.clearInterval(interval); };
  }, [isDemo, photo, refreshVersion]);

  if (!photo) {
    return <div className="ai-panel-content"><section className="ai-purpose-card"><header className="ai-purpose-heading"><Search size={15} /><strong>视觉分析</strong></header><p className="ai-empty-selection">选择图片以查看内容识别与修改建议</p></section><section className="ai-purpose-card ai-batch-destination"><header className="ai-purpose-heading"><Image size={15} /><strong>批量修图</strong><span>{workflowAssetIds.length} 张图片</span></header><button className="quiet-button compact" type="button" onClick={onOpenBatch}>打开批量修图<ChevronRight size={13} /></button></section></div>;
  }

  const targetIds = selectedIds.size > 0 && (workspaceTab !== 'workflow' || selectedIds.has(photo.id)) ? [...selectedIds] : [photo.id];
  const analyze = async () => {
    if (analyzing) return;
    const profile = profiles.find((item) => item.purpose === 'vision' && item.enabled);
    if (!profile) { setNotice('请先在设置中添加并启用视觉分析模型。'); return; }
    setAnalyzing(true);
    setNotice('');
    try {
      const batchId = crypto.randomUUID();
      const settled = await Promise.allSettled(targetIds.map((assetId) => window.desktopApi.enqueueTask({ kind: 'analysis', assetId, payload: { providerProfileId: profile.id, mode: 'full', batchId, locale: getLocale() } })));
      const succeeded = settled.filter((item) => item.status === 'fulfilled').length;
      setNotice(succeeded === targetIds.length ? `已将 ${succeeded} 张照片加入分析队列。` : succeeded ? `已加入 ${succeeded} 张；${targetIds.length - succeeded} 张加入失败，请重试。` : '加入分析队列失败，请检查模型配置或连接后重试。');
    } finally {
      setAnalyzing(false);
    }
  };
  const generate = async ({ providerProfileId, template, count, instruction, disabledActionIds }: { providerProfileId: string; template: PromptTemplate | null; count: number; instruction: string; disabledActionIds: Set<string> }) => {
    const batchId = crypto.randomUUID();
    let queued = 0;
    let skipped = 0;
    for (const assetId of targetIds) {
      const revisions = assetId === photo.id && revision ? [revision] : await window.desktopApi.listAnalysisRevisions(assetId);
      const current = revisions[0];
      if (!current) { skipped += 1; continue; }
      const analysis = { ...current.result, generativeActions: current.result.generativeActions.map((action) => ({ ...action, enabled: action.enabled && (assetId !== photo.id || !disabledActionIds.has(action.id)) })) };
      const prompt = composeGenerationPrompt({ templateBody: template?.body ?? DEFAULT_GENERATION_TEMPLATE_BODY, analysis, userInstruction: instruction });
      for (let resultIndex = 1; resultIndex <= count; resultIndex += 1) {
        await window.desktopApi.enqueueTask({ kind: 'generation', assetId, payload: { providerProfileId, batchId, prompt, templateId: template?.id ?? null, templateVersion: template?.version ?? null, resultIndex, storageMode, analysisRevisionId: current.id, disabledActionIds: current.result.generativeActions.filter((action) => action.enabled && !analysis.generativeActions.find((item) => item.id === action.id)?.enabled).map((action) => action.id), userInstruction: instruction } });
        queued += 1;
      }
    }
    window.dispatchEvent(new Event(OPEN_TASK_DRAWER_EVENT));
    return skipped > 0 ? `已加入 ${queued} 个生成任务；${skipped} 张未分析照片已跳过。` : `已加入 ${queued} 个生成任务。`;
  };
  const trash = async (resultId: string) => { await window.desktopApi.trashGenerationResult({ resultId }); setRefreshVersion((value) => value + 1); window.dispatchEvent(new CustomEvent(OPERATION_NOTICE_EVENT, { detail: '生成版本已移到应用回收站，原图未受影响。' })); };
  const restore = async (resultId: string) => { await window.desktopApi.restoreGenerationResult({ resultId }); setRefreshVersion((value) => value + 1); window.dispatchEvent(new CustomEvent(OPERATION_NOTICE_EVENT, { detail: '生成版本已恢复。' })); };

  const workflowIndex = workflowAssetIds.indexOf(photo.id);
  const latestAnalysisTask = tasks
    .filter((task) => task.kind === 'analysis' && task.assetId === photo.id && task.status !== 'canceled')
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  return <AiPanel photo={photo} results={results} trashedResults={trashedResults} revision={revision} isDemo={isDemo} notice={notice} onAnalyze={() => void analyze()} analyzing={analyzing} analysisTaskStatus={latestAnalysisTask?.status} analysisErrorCode={latestAnalysisTask?.errorCode ?? null} generationProfiles={profiles.filter((item) => item.purpose === 'generation' && item.enabled)} templates={templates} onOpenTemplates={onOpenTemplates} onGenerate={generate} onTrashResult={trash} onRestoreResult={restore} onOpenBatch={onOpenBatch} onAddToWorkflow={() => onAddAssetsToWorkflow(targetIds)} workflowQueueCount={workflowAssetIds.length} workflowPosition={workflowIndex >= 0 ? workflowIndex + 1 : null} selectionCount={targetIds.length} workflowRules={workflowRules} onWorkflowRulesChange={onWorkflowRulesChange} workflowTemplateId={workflowTemplateId} onWorkflowTemplateChange={onWorkflowTemplateChange} />;
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

function TaskAnalysisResult({ task }: { task: PersistedTask }): React.JSX.Element | null {
  const [legacyResult, setLegacyResult] = useState<AnalysisResult | null>(null);
  const parsed = analysisResultSchema.safeParse(task.result?.analysis);
  useEffect(() => {
    if (task.kind !== 'analysis' || task.status !== 'completed' || task.result?.analysis || !task.assetId) return;
    let active = true;
    void window.desktopApi.listAnalysisRevisions(task.assetId).then((revisions) => {
      const revision = revisions.find((item) => item.providerProfileId === task.payload.providerProfileId && item.createdAt >= task.createdAt && item.createdAt <= task.updatedAt);
      if (active) setLegacyResult(revision?.result ?? null);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [task.id, task.status, task.assetId, task.createdAt, task.updatedAt, task.payload.providerProfileId, task.result]);
  if (task.kind !== 'analysis' || task.status !== 'completed') return null;
  const result = parsed.success ? parsed.data : legacyResult;
  if (!result) return <div className="task-analysis-result">本次任务未保存可查看的分析结果</div>;
  return <details className="task-analysis-result"><summary><strong>{result.summary}</strong><span>{Math.round(result.quality.overallScore)} 分</span></summary><div className="task-analysis-report"><p>{result.report}</p><p>{result.catalog.longDescription}</p><div className="metadata-tags">{result.catalog.keywords.map((tag) => <span key={tag}>{tag}</span>)}</div>{result.quality.issues.map((issue, index) => <p key={index}>{issue.description}</p>)}{result.adjustments.global.map((item, index) => <p key={`adjust-${index}`}>{item.parameter} {item.value} {item.unit} · {item.reason}</p>)}{result.generativeActions.map((item) => <p key={item.id}>{item.target}：{item.instruction}</p>)}</div></details>;
}

function TaskOutput({ task, photos }: { task: PersistedTask; photos: Photo[] }): React.JSX.Element | null {
  if (task.kind === 'generation') {
    const generated = generationResultSchema.safeParse(task.result?.generation);
    return <details className="task-analysis-result"><summary>生成详情</summary><div className="task-analysis-report">{generated.success && <figure className="task-generated-result"><img src={generated.data.resultUrl} alt={generated.data.fileName} loading="lazy" /><figcaption>{generated.data.fileName}</figcaption></figure>}<p className="task-prompt-text">{typeof task.payload.prompt === 'string' ? task.payload.prompt : '未保存提示词'}</p></div></details>;
  }
  if (task.kind === 'collection-analysis') {
    const report = collectionAnalysisReportSchema.safeParse(task.result);
    if (!report.success) return null;
    const names = (ids: string[]) => ids.map((id) => photos.find((photo) => photo.id === id)?.fileName ?? id).join('、');
    return <details className="task-analysis-result"><summary>{report.data.summary}</summary><div className="task-analysis-report">{report.data.groups.map((group, index) => <p key={index}><strong>{group.title}</strong>：{names(group.assetIds)} · {group.reason}</p>)}<p>建议保留：{names(report.data.keepAssetIds) || '无'}</p><p>待复查：{names(report.data.reviewAssetIds) || '无'}</p>{report.data.recommendations.map((item, index) => <p key={index}>{item}</p>)}</div></details>;
  }
  if (task.kind === 'agent' && task.result) {
    const report = agentTaskResultSchema.safeParse(task.result);
    if (!report.success) return null;
    return <details className="task-analysis-result"><summary>执行结果 · {report.data.completedSteps.length} 步完成</summary><div className="task-analysis-report">{report.data.completedSteps.map((step, index) => <p key={index}>{step}</p>)}{report.data.skippedSteps.map((step, index) => <p key={`skip-${index}`}>跳过：{step}</p>)}{report.data.warnings.map((warning, index) => <p key={`warn-${index}`}>{warning}</p>)}</div></details>;
  }
  return null;
}

function useTaskPhotos(tasks: PersistedTask[], providedPhotos: Photo[]): Photo[] {
  const [resolved, setResolved] = useState<Photo[]>([]);
  const missingIds = [...new Set(tasks.flatMap((task) => task.assetId ? [task.assetId] : []))]
    .filter((id) => !providedPhotos.some((photo) => photo.id === id)).sort();
  const missingKey = JSON.stringify(missingIds);
  useEffect(() => {
    let active = true;
    const ids = JSON.parse(missingKey) as string[];
    void (async () => {
      const loaded: Photo[] = [];
      for (let offset = 0; offset < ids.length; offset += 500) {
        const page = await window.desktopApi.listCatalogAssetPage({ assetIds: ids.slice(offset, offset + 500), limit: 500 });
        loaded.push(...mapCatalogAssets(page.items));
      }
      if (active) setResolved(loaded);
    })().catch(() => { if (active) setResolved([]); });
    return () => { active = false; };
  }, [missingKey]);
  return [...providedPhotos, ...resolved.filter((photo) => !providedPhotos.some((item) => item.id === photo.id))];
}

function TaskBatchGroup({ tasks, photos: providedPhotos, children, onOpenViewer: openViewer, expanded = false, expandRequest = 0, compact = false }: { tasks: PersistedTask[]; photos: Photo[]; children?: React.ReactNode; onOpenViewer?: (assetId: string, assetIds?: string[]) => void; expanded?: boolean; expandRequest?: number; compact?: boolean }): React.JSX.Element {
  const photos = useTaskPhotos(tasks, providedPhotos);
  const onOpenViewer = openViewer ? (assetId: string) => openViewer(assetId, tasks.flatMap((task) => task.assetId ? [task.assetId] : [])) : undefined;
  const detailRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const element = detailRef.current;
    if (!element) return;
    const openRow = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest('button, input, a, summary')) return;
      const row = target.closest('.task-table-row, .task-activity-row');
      if (!row) return;
      const rows = [...element.querySelectorAll('.task-table-row, .task-activity-row')];
      const task = tasks[rows.indexOf(row)];
      if (task?.assetId && photos.some((photo) => photo.id === task.assetId)) onOpenViewer?.(task.assetId);
    };
    element.addEventListener('dblclick', openRow);
    return () => element.removeEventListener('dblclick', openRow);
  }, [tasks, photos, onOpenViewer]);
  useEffect(() => { if (expanded && detailRef.current) { detailRef.current.open = true; detailRef.current.scrollIntoView({ block: 'nearest' }); } }, [expanded, expandRequest]);
  const stats = batchProgress(tasks);
  const first = tasks[0]!;
  const title = `${taskLabels[first.kind]} · ${new Date(Math.min(...tasks.map((task) => task.createdAt))).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  const summary = <><ChevronRight size={14} /><TaskKindIcon kind={first.kind} /><span className="task-batch-heading"><strong>{title}</strong><small>{taskImageName(first, photos)}{tasks.length > 1 ? ` 等 ${stats.total} 项` : ` · ${stats.total} 项`}</small></span><span className="task-batch-counts"><span>成功 {stats.completed}</span>{(!compact || stats.active > 0) && <span>处理中 {stats.active}</span>}{(!compact || stats.queued > 0) && <span>等待 {stats.queued}</span>}{stats.paused > 0 && <span>暂停 {stats.paused}</span>}{(!compact || stats.failed > 0) && <span className={stats.failed > 0 ? 'failed-count' : ''}>失败 {stats.failed}</span>}{stats.canceled > 0 && <span>取消 {stats.canceled}</span>}</span><progress aria-label="批次进度" max={Math.max(stats.total, 1)} value={stats.settled} /></>;
  return <details ref={detailRef} className={`task-batch-group${compact ? ' is-compact' : ''}`}><summary className="task-batch-summary" data-task-batch={first.id}>{summary}<TaskBatchButtons tasks={tasks} /></summary><div className="task-batch-members">{children ?? tasks.map((task) => { const photo = photos.find((item) => item.id === task.assetId); return <div className="task-batch-member" key={task.id}><div className="task-row task-activity-row" data-task-id={task.id}><button className="task-member-preview" type="button" disabled={!photo || !onOpenViewer} onClick={() => { if (photo && onOpenViewer) onOpenViewer(photo.id); }} aria-label={photo ? `预览 ${photo.fileName}` : '任务图片预览'}>{(photo?.thumbnailSrc || photo?.src) ? <img src={photo.thumbnailSrc || photo.src} alt={photo.fileName} /> : <TaskKindIcon kind={task.kind} />}</button><span className="task-title"><strong>{taskImageName(task, photos)}</strong><small>{taskScope(task)}</small></span><span className={`task-state state-${task.status}`}>{taskStage(task)}</span></div>{task.status === 'failed' && ((task.kind === 'analysis' || task.kind === 'collection-analysis') ? <AnalysisFailure code={task.errorCode} taskId={task.id} className="task-analysis-failure" /> : <div className="task-analysis-failure" role="alert">{task.kind === 'export' ? exportFailureMessage(task.errorCode ?? '') : '任务执行失败'} <code>{task.errorCode}</code></div>)}<TaskAnalysisResult task={task} /><TaskOutput task={task} photos={photos} />{task.kind === 'export' && task.result && <div className="task-analysis-result">成功 {Number(task.result.succeeded) || 0} · 失败 {Number(task.result.failed) || 0}{exportTaskReport(task)?.files.map((file) => <p key={file.resultId}>{file.fileName}</p>)}{exportTaskReport(task)?.failures.map((failure) => <p key={failure.resultId}>{exportFailureMessage(failure.errorCode)} · {failure.errorCode}</p>)}</div>}</div>; })}</div></details>;
}

function TaskBar({ panelVisibility, onTogglePanel, suspended, open, onToggle, onOpenTaskCenter, onOpenViewer: openViewer, tasks, counts, photos }: { panelVisibility: { left: boolean; right: boolean }; onTogglePanel: (side: 'left' | 'right') => void; suspended: boolean; open: boolean; onToggle: () => void; onOpenTaskCenter: () => void; onOpenViewer: (assetId: string, assetIds?: string[]) => void; tasks: PersistedTask[] | null; counts?: Pick<TaskPage, 'activeCount' | 'queuedCount' | 'failedCount' | 'pausedCount'>; photos: Photo[] }): React.JSX.Element {
  const [expandedBatch, setExpandedBatch] = useState<{ id: string; request: number } | null>(null);
  const expandBatch = (id: string) => {
    setExpandedBatch((previous) => ({ id, request: (previous?.request ?? 0) + 1 }));
    if (!open) onToggle();
  };
  const isDemo = tasks === null;
  const visibleTasks = (tasks ?? []).filter((task) => !['completed', 'failed', 'canceled'].includes(task.status))
    .sort((left, right) => Number(['queued', 'paused'].includes(left.status)) - Number(['queued', 'paused'].includes(right.status)) || left.position - right.position);
  const runningCount = isDemo ? 0 : counts?.activeCount ?? visibleTasks.filter((task) => ['preparing', 'uploading', 'processing', 'downloading', 'saving'].includes(task.status)).length;
  const waitingCount = isDemo ? 0 : counts?.queuedCount ?? visibleTasks.filter((task) => task.status === 'queued').length;
  const failedCount = isDemo ? 0 : counts?.failedCount ?? 0;
  const pausedCount = isDemo ? 0 : counts?.pausedCount ?? visibleTasks.filter((task) => task.status === 'paused').length;
  const batches = groupTaskBatches(tasks ?? []);
  const onOpenViewer = (assetId: string, assetIds?: string[]) => openViewer(assetId, assetIds ?? batches.find((batch) => batch.tasks.some((task) => task.assetId === assetId))?.tasks.flatMap((task) => task.assetId ? [task.assetId] : []));
  const pendingBatches = batches.filter((batch) => batch.active + batch.queued + batch.paused > 0);

  return (
    <TaskActions tasks={groupTaskBatches(tasks ?? []).flatMap((batch) => batch.tasks)} onOpenViewer={onOpenViewer}>
      {open && (
        <div className="task-drawer" inert={suspended} aria-hidden={suspended ? true : undefined} style={suspended ? { visibility: 'hidden' } : undefined}>
          <div className="drawer-head"><div><strong>后台任务</strong><span>{pendingBatches.length} 批进行中</span></div><div><button className="quiet-button" type="button" onClick={onOpenTaskCenter}><ListFilter size={13} />全部任务与历史</button><IconButton label="关闭任务抽屉" onClick={onToggle}><X size={15} /></IconButton></div></div>
          {isDemo || batches.length === 0 ? <div className="drawer-empty">暂无后台任务</div> : batches.map((batch) => <TaskBatchGroup key={batch.id} tasks={batch.tasks} photos={photos} onOpenViewer={onOpenViewer} compact expanded={expandedBatch?.id === batch.id} expandRequest={expandedBatch?.request ?? 0} />)}
        </div>
      )}
      <div className="task-statusbar">
        <button className="panel-visibility-toggle" type="button" aria-label={panelVisibility.left ? '隐藏左侧栏' : '显示左侧栏'} aria-expanded={panelVisibility.left} title={panelVisibility.left ? '隐藏左侧栏（Tab 切换两侧）' : '显示左侧栏（Tab 切换两侧）'} onClick={() => onTogglePanel('left')}>{panelVisibility.left ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}</button>
        <button className="task-status-toggle" type="button" onClick={onToggle} aria-expanded={open} aria-label="后台任务"><span className={`working-pulse${runningCount === 0 ? ' is-idle' : ''}`} /><strong>后台任务</strong><span>{pendingBatches.length} 批进行中</span></button>
        <div className="task-status-batches">{pendingBatches.map((batch) => <button type="button" className="task-status-batch" key={batch.id} onClick={() => expandBatch(batch.id)}><TaskKindIcon kind={batch.tasks[0]!.kind} /><span>{taskLabels[batch.tasks[0]!.kind]} {batch.settled}/{batch.total}</span><progress aria-label="批次进度" max={Math.max(batch.total, 1)} value={batch.settled} /></button>)}</div>
        <span>运行 {runningCount} 项</span><span>排队 {waitingCount} 项</span>{pausedCount > 0 && <span>暂停 {pausedCount} 项</span>}{failedCount > 0 && <span className="failed-count">失败 {failedCount} 项</span>}<button className="task-status-toggle" type="button" onClick={onToggle} aria-label={open ? '收起后台任务' : '展开后台任务'}><PanelBottomOpen size={15} className={open ? 'is-open' : ''} /></button>
        <button className="panel-visibility-toggle" type="button" aria-label={panelVisibility.right ? '隐藏右侧栏' : '显示右侧栏'} aria-expanded={panelVisibility.right} title={panelVisibility.right ? '隐藏右侧栏（Tab 切换两侧）' : '显示右侧栏（Tab 切换两侧）'} onClick={() => onTogglePanel('right')}>{panelVisibility.right ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}</button>
      </div>
    </TaskActions>
  );
}

type LibraryWorkspaceProps = {
  active?: boolean;
  onCloseViewer?: () => void;
  initialResultId?: string | null;
  view: 'library' | 'viewer';
  onOpenViewer: (assetId: string) => void;
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
  onSynchronizeFolder: (folderId: string) => Promise<{ discovered: number; offline: number }>;
  onRevealFolder: (folderId: string) => Promise<boolean>;
  onUnregisterFolder: (folderId: string) => Promise<void>;
  onMoveFolder: (sourceFolderId: string, targetFolderId: string) => Promise<CatalogFolder>;
  onSelectTag: (tagId: string | null) => void;
  onLoadMore: () => void;
  searchQuery: string;
  selectedAssetId: string | null;
  onSelectedAssetChange: (assetId: string | null) => void;
  selection: SelectionState;
  onSelectionChange: React.Dispatch<React.SetStateAction<SelectionState>>;
  onRefreshCatalog: () => Promise<void>;
  onOpenTaskCenter: () => void;
  onOpenTemplates: () => void;
  onAddAssetsToWorkflow: (ids: string[]) => void;
  onAddAssetsToAgent?: (ids: string[]) => void;
  onAddAssetsToBatch?: (ids: string[]) => void;
};

function LibraryWorkspace(props: LibraryWorkspaceProps): React.JSX.Element {
  if (props.availablePhotos.length > 0) {
    return <PopulatedLibraryWorkspace {...props} />;
  }
  return (
    <div className="workspace viewer-workspace">
      {props.view === 'library' ? <CatalogWorkspace {...props} /> :
      <main className="empty-library-main">
        {props.catalogFolders.length === 0 ? <FolderOpen size={30} /> : <Search size={30} />}
        <h2>{props.catalogFolders.length === 0 ? '添加照片文件夹' : props.searchQuery ? '没有匹配的照片' : '此集合为空'}</h2>
        <p>{props.catalogFolders.length === 0 ? '照片仍保留在原位置，PhotoAllIsAI 只建立本地图库索引。' : props.searchQuery ? '尝试其他文件名、场景、主体或 AI 关键词。' : '从其他目录选择照片，或导入新的照片文件夹。'}</p>
        {props.catalogFolders.length === 0 && <button className="primary-action compact" type="button" onClick={() => void props.onImportFolders()}><Plus size={14} />选择文件夹</button>}
      </main>}
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

function CatalogWorkspace(props: LibraryWorkspaceProps & { onOpenViewer: (assetId: string) => void; onOpenPhotoContextMenu?: (event: React.MouseEvent, photo: Photo) => void }): React.JSX.Element {
  const selection = props.selection;
  const setSelection = props.onSelectionChange;
  const gridRef = useRef<HTMLElement>(null);
  const marqueeOriginRef = useRef<{ x: number; y: number; additive: boolean; initialIds: Set<string> } | null>(null);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [viewMode, setViewMode] = useState<CatalogViewMode>(() => {
    try { return (window.localStorage.getItem('photoallisai.catalog-view-mode') as CatalogViewMode) || 'grid'; } catch { return 'grid'; }
  });
  const orderedIds = useMemo(() => props.availablePhotos.map((photo) => photo.id), [props.availablePhotos]);
  const selectedPhoto = props.availablePhotos.find((photo) => selection.focusId === photo.id) ?? null;

  useEffect(() => {
    const selectPhotos = (event: Event) => {
      if (event.target === gridRef.current) setSelection(selectAll(orderedIds));
    };
    window.addEventListener('photoallisai:select-all-photos', selectPhotos);
    return () => window.removeEventListener('photoallisai:select-all-photos', selectPhotos);
  }, [orderedIds, setSelection]);

  const selectPhoto = (photo: Photo, intent: SelectionIntent) => {
    if (intent === 'replace' && selection.selectedIds.has(photo.id)) {
      setSelection({ ...selection, focusId: photo.id });
      props.onSelectedAssetChange(photo.id);
      return;
    }
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
  const changeViewMode = (mode: CatalogViewMode) => {
    setViewMode(mode);
    try { window.localStorage.setItem('photoallisai.catalog-view-mode', mode); } catch { /* restricted storage */ }
  };
  const allVisibleSelected = orderedIds.length > 0 && orderedIds.every((id) => selection.selectedIds.has(id));
  const someVisibleSelected = orderedIds.some((id) => selection.selectedIds.has(id));
  const selectButton = (photo: Photo) => <input className="catalog-list-select" type="checkbox" aria-label={`选择 ${photo.fileName}`} checked={selection.selectedIds.has(photo.id)} onClick={(event) => event.stopPropagation()} onChange={() => selectPhoto(photo, 'toggle')} />;
  const photoImage = (photo: Photo) => <span className="catalog-list-thumb">{photo.thumbnailSrc || photo.src ? <CatalogImage src={photo.thumbnailSrc ?? photo.src} alt="" /> : <Image size={18} />}</span>;
  const listRows = props.availablePhotos.map((photo) => <div className={`catalog-list-row${selection.selectedIds.has(photo.id) ? ' is-selected' : ''}${selection.focusId === photo.id ? ' is-focused' : ''}`} key={photo.id} data-asset-id={photo.id} onContextMenu={(event) => props.onOpenPhotoContextMenu?.(event, photo)} onDoubleClick={() => { selectPhoto(photo, 'replace'); props.onOpenViewer(photo.id); }}>
    {selectButton(photo)}{photoImage(photo)}<span className="catalog-list-name"><strong>{photo.fileName}</strong><small>{photo.format}</small></span><span>{photo.dimensions}</span><span>{photo.rating ? `${photo.rating} 星` : '未评分'}</span><span className="catalog-list-analysis">{viewMode === 'analysis' ? (photo.offline ? '文件离线，等待重新关联' : photo.rating >= 4 ? '建议保留，可作为精选' : '等待视觉识别与建议') : ''}</span><button className="quiet-button compact" type="button" onClick={() => { selectPhoto(photo, 'replace'); props.onOpenViewer(photo.id); }}>打开</button>
  </div>);
  return (
    <>
      <main className="catalog-main">
        <header className="catalog-toolbar">
          <div className="result-summary"><strong>{collectionTitle(props)}</strong><span>{props.totalCount} 张照片</span></div>
          <div className="catalog-toolbar-actions">
            <div className="catalog-view-switcher" role="group" aria-label="图库视图"><button className={viewMode === 'list' ? 'is-active' : ''} type="button" aria-label="列表视图" title="列表视图" onClick={() => changeViewMode('list')}><ListFilter size={14} /></button><button className={viewMode === 'grid' ? 'is-active' : ''} type="button" aria-label="网格视图" title="网格视图" onClick={() => changeViewMode('grid')}><Grid2X2 size={14} /></button><button className={viewMode === 'analysis' ? 'is-active' : ''} type="button" aria-label="分析视图" title="分析视图" onClick={() => changeViewMode('analysis')}><WandSparkles size={14} /></button></div>
            <label className="sort-control"><select aria-label="图库排序" value={props.sortBy} onChange={(event) => props.onSortByChange(event.target.value as CatalogSort)}><option value="modifiedAt">拍摄时间</option><option value="fileName">文件名</option><option value="rating">评分</option></select><ChevronDown size={12} /></label>
            <button className={`quiet-button${props.favoriteOnly ? ' is-active' : ''}`} type="button" onClick={() => props.onFavoriteOnlyChange(!props.favoriteOnly)}><Star size={13} />仅首选</button>
          </div>
        </header>
        {props.availablePhotos.length === 0 ? (
          <section className="catalog-empty">
            {props.catalogFolders.length === 0 ? <FolderOpen size={34} /> : <Search size={34} />}
            <h2>{props.catalogFolders.length === 0 ? '添加照片文件夹' : props.searchQuery ? '没有匹配的照片' : '此集合为空'}</h2>
            <p>{props.catalogFolders.length === 0 ? '不会复制或修改原图，只建立本地索引。' : '请选择其他目录或调整筛选条件。'}</p>
            {props.catalogFolders.length === 0 && <button className="primary-action compact" type="button" onClick={() => void props.onImportFolders()}><Plus size={14} />选择文件夹</button>}
          </section>
        ) : viewMode !== 'grid' ? (
          <section className={`catalog-list-view catalog-list-view-${viewMode}`} role="listbox" ref={gridRef} tabIndex={0} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && !(event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]'))) { event.preventDefault(); setSelection(selectAll(orderedIds)); } }} aria-label={viewMode === 'analysis' ? '图库分析视图' : '图库列表视图'}><div className="catalog-list-header"><input className="catalog-list-select" type="checkbox" aria-label="全选当前列表" title="全选当前列表" checked={allVisibleSelected} ref={(element) => { if (element) element.indeterminate = someVisibleSelected && !allVisibleSelected; }} onChange={() => setSelection(allVisibleSelected ? { selectedIds: new Set(), anchorId: null, focusId: null } : selectAll(orderedIds))} /><span>缩略图</span><span>文件</span><span>大小</span><span>评分</span><span>{viewMode === 'analysis' ? '分析与建议' : '操作'}</span><span /></div>{listRows}{props.hasMore && <button className="catalog-load-more" type="button" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? '加载中…' : '加载更多'}</button>}</section>
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
            {props.availablePhotos.map((photo) => <button className={`catalog-card${selection.selectedIds.has(photo.id) ? ' is-selected' : ''}${selection.focusId === photo.id ? ' is-focused' : ''}${photo.offline ? ' is-offline' : ''}`} type="button" role="option" aria-selected={selection.selectedIds.has(photo.id)} aria-grabbed={selection.selectedIds.has(photo.id)} data-asset-id={photo.id} draggable key={photo.id} onDragStart={(event) => { preparePhotoDrag(event, photo, selection); }} onContextMenu={(event) => props.onOpenPhotoContextMenu?.(event, photo)} onClick={(event) => selectPhoto(photo, event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'replace')} onDoubleClick={() => { if (!selection.selectedIds.has(photo.id)) selectPhoto(photo, 'replace'); props.onOpenViewer(photo.id); }}>
              <span className="catalog-card-image"><span className="raw-placeholder"><Image size={25} /><small>{photo.format}</small></span>{photo.thumbnailSrc || photo.src ? <CatalogImage src={photo.thumbnailSrc ?? photo.src} /> : null}{selection.selectedIds.has(photo.id) && <span className="selection-check"><Check size={12} /></span>}{photo.offline && <i className="offline-badge">离线</i>}</span>
              <span className="catalog-card-meta"><strong>{photo.fileName}</strong><small>{photo.format} · {photo.dimensions}</small>{photo.rating > 0 && <span aria-label={`${photo.rating} 星`}>{Array.from({ length: photo.rating }, (_, index) => <Star key={index} size={10} fill="currentColor" />)}</span>}</span>
            </button>)}
            {props.hasMore && <button className="catalog-load-more" type="button" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? '加载中…' : '加载更多'}</button>}
            {marquee && <span className="selection-marquee" style={marquee} aria-hidden="true" />}
          </section>
        )}
      </main>
    </>
  );
}

type PopulatedLibraryWorkspaceProps = LibraryWorkspaceProps;

function PopulatedLibraryWorkspace(props: PopulatedLibraryWorkspaceProps): React.JSX.Element {
  const {
    view,
    availablePhotos,
    catalogFolders,
    catalogAlbums,
    exportPresets,
    isDemo,
    selectedFolderId,
    selectedAlbumId,
    selectedSmartCollection,
    totalCount,
    favoriteOnly,
    onFavoriteOnlyChange,
    sortBy,
    onSortByChange,
    hasMore,
    loadingMore,
    onLoadMore,
    searchQuery,
    selectedAssetId,
    onSelectedAssetChange,
    selection,
    onSelectionChange,
    onRefreshCatalog,
    onAddAssetsToWorkflow,
    onAddAssetsToAgent,
    onAddAssetsToBatch
  } = props;
  const [viewerToolbarHost, setViewerToolbarHost] = useState<HTMLDivElement | null>(null);
  const [operationNotice, setOperationNotice] = useState('');
  const [viewerLayout, setViewerLayout] = useViewerLayout();
  const initialSelectedId = availablePhotos.some((photo) => photo.id === selectedAssetId)
    ? selectedAssetId!
    : availablePhotos[0]!.id;
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const setSelection = onSelectionChange;
  const [visionProfiles, setVisionProfiles] = useState<ProviderProfile[]>([]);
  const [generationProfiles, setGenerationProfiles] = useState<ProviderProfile[]>([]);
  const [generationStorageMode, setGenerationStorageMode] = useState<AppSettings['generationStorageMode']>('managed');
  const [templateItems, setTemplateItems] = useState<PromptTemplate[]>([]);
  const [analysisRevision, setAnalysisRevision] = useState<AnalysisRevision>();
  const [analysisAssetId, setAnalysisAssetId] = useState<string | null>(null);
  const [generationResults, setGenerationResults] = useState<GenerationResult[]>([]);
  const [generationAssetId, setGenerationAssetId] = useState<string | null>(null);
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
  const [photoContextMenu, setPhotoContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [selectedExportPresetId, setSelectedExportPresetId] = useState<string | null>(exportPresets[0]?.id ?? null);
  const [exportSelectionMode, setExportSelectionMode] = useState<ExportSelectionMode>('preferred-or-latest');
  const [trackedExport, setTrackedExport] = useState<{ taskId: string; notice: string; surface: 'viewer' | 'operation' } | null>(null);
  const trackedExportTaskId = trackedExport?.taskId ?? null;
  const trackedExportSurface = trackedExport?.surface ?? null;
  const selected = availablePhotos.find((photo) => photo.id === selectedAssetId) ?? availablePhotos.find((photo) => photo.id === selectedId) ?? availablePhotos[0]!;
  const currentAnalysisRevision = analysisAssetId === selected.id ? analysisRevision : undefined;
  const currentGenerationResults = generationAssetId === selected.id ? generationResults : [];
  const orderedIds = useMemo(() => availablePhotos.map((photo) => photo.id), [availablePhotos]);
  const collectionName = selectedFolderId
    ? catalogFolders.find((folder) => folder.id === selectedFolderId)?.name ?? '文件夹'
    : selectedAlbumId
      ? catalogAlbums.find((album) => album.id === selectedAlbumId)?.name ?? '相册'
      : selectedSmartCollection
        ? selectedSmartCollection === 'recent' ? '最近 30 天' : selectedSmartCollection === 'favorites' ? '首选照片' : selectedSmartCollection === 'unrated' ? '未评分' : selectedSmartCollection === 'unanalyzed' ? '等待 AI 分析' : selectedSmartCollection === 'to-review' ? '待审阅' : '已生成'
        : isDemo ? '2026 人像作品' : searchQuery ? `搜索：${searchQuery}` : '所有照片';

  useEffect(() => {
    const showNotice = (event: Event) => setOperationNotice((event as CustomEvent<string>).detail);
    window.addEventListener(OPERATION_NOTICE_EVENT, showNotice);
    return () => window.removeEventListener(OPERATION_NOTICE_EVENT, showNotice);
  }, [setOperationNotice]);

  useEffect(() => {
    if (availablePhotos.some((photo) => photo.id === selectedAssetId)) return;
    if (availablePhotos.some((photo) => photo.id === selectedId)) { onSelectedAssetChange(selectedId); return; }
    const first = availablePhotos[0];
    if (!first) return;
    setSelectedId(first.id);
    onSelectedAssetChange(first.id);
    setSelection({ selectedIds: new Set([first.id]), anchorId: first.id, focusId: first.id });
  }, [availablePhotos, onSelectedAssetChange, selectedAssetId, selectedId, setSelection]);

  useEffect(() => {
    if (selectedExportPresetId && exportPresets.some((preset) => preset.id === selectedExportPresetId)) return;
    setSelectedExportPresetId(exportPresets[0]?.id ?? null);
  }, [exportPresets, selectedExportPresetId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (props.active === false) return;
      if (event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest('input, textarea, select, [contenteditable="true"]') || !target.closest('.filmstrip, .catalog-grid, .catalog-list-view, .canvas-wrap')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        if (!target.closest('.filmstrip, .catalog-grid, .catalog-list-view')) return;
        event.preventDefault();
        setSelection(selectAll(orderedIds));
      } else if (!isDemo && !event.metaKey && !event.ctrlKey && !event.altKey && /^[0-5]$/.test(event.key)) {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
        event.preventDefault();
        const assetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
        void window.desktopApi.updateCatalogMetadata({ assetIds, rating: Number(event.key) }).then(onRefreshCatalog);
      } else if (view === 'viewer' && !event.metaKey && !event.ctrlKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof Element && (target.closest('.filmstrip') || target.closest('[role="slider"]')))) return;
        event.preventDefault();
        const currentIndex = Math.max(0, orderedIds.indexOf(selected.id));
        const nextId = orderedIds[clamp(currentIndex + (event.key === 'ArrowLeft' ? -1 : 1), 0, orderedIds.length - 1)];
        const nextPhoto = availablePhotos.find((photo) => photo.id === nextId);
        if (!nextPhoto || nextPhoto.id === selected.id) return;
        setSelectedId(nextPhoto.id);
        onSelectedAssetChange(nextPhoto.id);
        setSelection((current) => updateSelection(current, orderedIds, nextPhoto.id, event.shiftKey ? 'range' : 'replace'));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [props.active, availablePhotos, isDemo, onRefreshCatalog, onSelectedAssetChange, orderedIds, selected.id, selection.selectedIds, setSelection, view]);

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
      void window.desktopApi.listGenerationResults(selected.id).then((items) => {
        if (active) {
          setGenerationResults(items);
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
      void window.desktopApi.listTaskPage({ includeBatchMembers: true, limit: 20, cursor: null }).then((page) => {
        if (active) setTaskItems(page.items);
      });
    };
    refresh();
    window.addEventListener(TASKS_CHANGED_EVENT, refresh);
    const interval = window.setInterval(refresh, 1_000);
    return () => { active = false; window.clearInterval(interval); window.removeEventListener(TASKS_CHANGED_EVENT, refresh); };
  }, [isDemo]);

  const selectPhoto = (photo: Photo, intent: SelectionIntent) => {
    setSelectedId(photo.id);
    onSelectedAssetChange(photo.id);
    if (intent === 'replace' && selection.selectedIds.has(photo.id)) {
      setSelection({ ...selection, focusId: photo.id });
      return;
    }
    setSelection((current) => updateSelection(current, orderedIds, photo.id, intent));
  };

  const openPhotoContextMenu = (event: React.MouseEvent, photo: Photo, forceSingle = false) => {
    event.preventDefault();
    if (forceSingle || !selection.selectedIds.has(photo.id)) {
      setSelection({ selectedIds: new Set([photo.id]), anchorId: photo.id, focusId: photo.id });
    }
    setSelectedId(photo.id);
    onSelectedAssetChange(photo.id);
    setPhotoContextMenu({ x: event.clientX, y: event.clientY });
  };

  useEffect(() => {
    if (!photoContextMenu) return;
    const close = () => setPhotoContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('blur', close); window.removeEventListener('keydown', closeOnEscape); };
  }, [photoContextMenu]);

  const analyzeSelection = useCallback(async () => {
    const profile = visionProfiles[0];
    if (!profile) {
      setOperationNotice('请先在设置中添加并启用视觉分析模型。');
      return;
    }
    const targetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
    const batchId = crypto.randomUUID();
    await Promise.all(targetIds.map((assetId) => window.desktopApi.enqueueTask({
      kind: 'analysis',
      assetId,
      payload: { providerProfileId: profile.id, mode: 'full', batchId, locale: getLocale() }
    })));
    setOperationNotice(`已将 ${targetIds.length} 张照片加入分析队列。`);
  }, [selected.id, selection.selectedIds, setOperationNotice, visionProfiles]);

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

  const generateSelection = useCallback(async ({
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
    window.dispatchEvent(new Event(OPEN_TASK_DRAWER_EVENT));
    return skipped > 0
      ? `已加入 ${queued} 个生成任务；${skipped} 张照片因尚未分析而跳过。`
      : `已加入 ${queued} 个生成任务。`;
  }, [currentAnalysisRevision, generationStorageMode, selected.id, selection.selectedIds]);

  useEffect(() => {
    const onMenuCommand = (event: Event) => {
      const command = (event as CustomEvent<MenuCommand>).detail;
      if (command === 'analyze-selection') {
        if (props.active === false) return;
        void analyzeSelection();
      } else if (command === 'generate-selection') {
        if (props.active === false) return;
        const profile = generationProfiles[0];
        if (profile) void generateSelection({
          providerProfileId: profile.id,
          template: templateItems[0] ?? null,
          count: 1,
          instruction: '',
          disabledActionIds: new Set()
        }).then(setOperationNotice);
      } else if (command === 'open-task-center') {
        if (props.active === false) return;
        window.dispatchEvent(new Event(OPEN_TASK_DRAWER_EVENT));
      }
    };
    window.addEventListener('photoallisai:menu-command', onMenuCommand);
    return () => window.removeEventListener('photoallisai:menu-command', onMenuCommand);
  }, [props.active, generationProfiles, templateItems, selection.selectedIds, selected.id, analyzeSelection, generateSelection, setOperationNotice]);

  useEffect(() => {
    if (props.active === false) return;
    const counts = taskItems.reduce((result, task) => {
      const terminal = task.status === 'completed' || task.status === 'failed' || task.status === 'canceled';
      result.total += terminal ? 0 : 1;
      result.running ||= task.status === 'preparing' || task.status === 'uploading' || task.status === 'processing' || task.status === 'downloading' || task.status === 'saving';
      return result;
    }, { total: 0, running: false });
    window.desktopApi.updateMenuState({
      activeTab: view === 'viewer' ? 'viewer' : 'library',
      hasSelection: selection.selectedIds.size > 0,
      selectionCount: selection.selectedIds.size,
      hasVisionProvider: visionProfiles.length > 0,
      hasGenerationProvider: generationProfiles.length > 0,
      taskCount: counts.total,
      hasRunningTask: counts.running
    });
  }, [props.active, generationProfiles.length, selection.selectedIds.size, taskItems, view, visionProfiles.length]);

  const exportResults = async (
    resultIds: string[],
    presetId = selectedExportPresetId,
    surface: 'viewer' | 'operation' = 'viewer'
  ): Promise<string> => {
    try {
      const task = await window.desktopApi.exportGenerationResults({ resultIds, presetId });
      if (!task) return '已取消导出';
      window.dispatchEvent(new Event(OPEN_TASK_DRAWER_EVENT));
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
    window.dispatchEvent(new Event(OPEN_TASK_DRAWER_EVENT));
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

  const updateAlbumMembership = async (mode: 'add' | 'remove', targetAlbumId?: string) => {
    const albumId = mode === 'remove' ? selectedAlbumId : targetAlbumId ?? albumTargetId;
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
    <div className="workspace viewer-workspace">
      {view === 'library' ? <CatalogWorkspace {...props} onOpenPhotoContextMenu={(event, photo) => openPhotoContextMenu(event, photo)} /> :
      <main className="library-main" style={{ gridTemplateRows: `minmax(0, 1fr) 5px ${viewerLayout.filmstripHeight}px` }}>
        <Viewer photo={selected} results={currentGenerationResults} isDemo={isDemo} exportPresets={exportPresets} selectedExportPresetId={selectedExportPresetId} trackedExportNotice={trackedExport?.surface === 'viewer' ? trackedExport.notice : ''} onExportPresetChange={setSelectedExportPresetId} onExport={exportResults} onRegenerate={regenerate} onReview={reviewResult} onRevealResult={(resultId) => void window.desktopApi.revealGenerationResult(resultId)} onOpenContextMenu={(event) => openPhotoContextMenu(event, selected, true)} onClose={props.onCloseViewer} initialResultId={props.initialResultId} onToolbarHostChange={setViewerToolbarHost} />
        <PaneSplitter orientation="horizontal" value={viewerLayout.filmstripHeight} minimum={110} maximum={320} label="调整大图和胶片带高度" invert onChange={(value) => setViewerLayout('filmstripHeight', value)} />
        <Filmstrip toolbarHost={viewerToolbarHost} items={availablePhotos} selected={selected} selection={selection} onSelect={selectPhoto} onSelectionChange={setSelection} onFocusPhoto={(photo) => { setSelectedId(photo.id); onSelectedAssetChange(photo.id); }} collectionName={collectionName} totalCount={totalCount} favoriteOnly={favoriteOnly} onFavoriteOnlyChange={onFavoriteOnlyChange} sortBy={sortBy} onSortByChange={onSortByChange} hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} onOpenContextMenu={(event, photo) => openPhotoContextMenu(event, photo)} />
      </main>}
      {photoContextMenu && <div className="folder-context-menu photo-context-menu" role="menu" aria-label={`照片菜单 ${selection.selectedIds.size} 张`} style={{ left: Math.min(photoContextMenu.x, Math.max(8, window.innerWidth - 244)), top: Math.min(photoContextMenu.y, Math.max(8, window.innerHeight - 530)) }} onPointerDown={(event) => event.stopPropagation()}>
        <div className="folder-menu-title"><Image size={14} /><span>{selection.selectedIds.size > 1 ? `${selection.selectedIds.size} 张照片` : selected.fileName}</span></div>
        <div className="photo-menu-rating"><span>评分</span><button type="button" aria-label="清除评分" onClick={() => { void rateSelection(0); setPhotoContextMenu(null); }}>0</button>{[1, 2, 3, 4, 5].map((rating) => <button type="button" aria-label={`${rating} 星`} key={rating} onClick={() => { void rateSelection(rating); setPhotoContextMenu(null); }}><Star size={12} fill={rating <= selected.rating && selection.selectedIds.size === 1 ? 'currentColor' : 'none'} /></button>)}</div>
        <button type="button" role="menuitem" onClick={() => { void favoriteSelection(![...selection.selectedIds].every((id) => availablePhotos.find((photo) => photo.id === id)?.favorite)); setPhotoContextMenu(null); }}><Heart size={14} /><span>{[...selection.selectedIds].every((id) => availablePhotos.find((photo) => photo.id === id)?.favorite) ? '取消首选' : '标记为首选'}</span></button>
        <button type="button" role="menuitem" onClick={() => { setTagEditorOpen(true); setPhotoContextMenu(null); }}><Tags size={14} /><span>添加标签…</span></button>
        <span className="folder-menu-separator" />
        <button type="button" role="menuitem" onClick={() => { void analyzeSelection(); setPhotoContextMenu(null); }}><Sparkles size={14} /><span>AI 分析{selection.selectedIds.size > 1 ? ` ${selection.selectedIds.size} 张` : ''}</span></button>
        <button type="button" role="menuitem" onClick={() => { onAddAssetsToAgent?.(selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id]); setPhotoContextMenu(null); }}><Bot size={14} /><span>加入 Agent 批处理{selection.selectedIds.size > 1 ? `（${selection.selectedIds.size} 张）` : ''}</span></button>
        <button type="button" role="menuitem" onClick={() => { onAddAssetsToBatch?.(selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id]); setPhotoContextMenu(null); }}><Sparkles size={14} /><span>加入 AI 批量修图{selection.selectedIds.size > 1 ? `（${selection.selectedIds.size} 张）` : ''}</span></button>
        <button type="button" role="menuitem" disabled={generationProfiles.length === 0} onClick={() => { void generateSelection({ providerProfileId: generationProfiles[0]!.id, template: null, count: 1, instruction: '', disabledActionIds: new Set() }); setPhotoContextMenu(null); }}><WandSparkles size={14} /><span>按默认方案生成</span></button>
        <div className="photo-menu-export-options"><select aria-label="导出版本范围" value={exportSelectionMode} onChange={(event) => setExportSelectionMode(event.target.value as ExportSelectionMode)}><option value="preferred-or-latest">每张首选 / 最新版本</option><option value="accepted">所有已接受版本</option><option value="all">所有生成版本</option></select><select aria-label="右键菜单导出预设" value={selectedExportPresetId ?? ''} onChange={(event) => setSelectedExportPresetId(event.target.value || null)}><option value="">默认命名</option>{exportPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></div>
        <button type="button" role="menuitem" onClick={() => { void exportLatestSelection(); setPhotoContextMenu(null); }}><Download size={14} /><span>导出 AI 版本…</span></button>
        {!isDemo && <><span className="folder-menu-separator" />{selection.selectedIds.size === 1 && <button type="button" role="menuitem" onClick={() => { void window.desktopApi.revealCatalogAsset(selected.id); setPhotoContextMenu(null); }}><FolderOpen size={14} /><span>{FILE_MANAGER_LABEL}</span></button>}<button type="button" role="menuitem" onClick={() => { if (selection.selectedIds.size > 1) setBatchRenameDialogOpen(true); else openRenameDialog(); setPhotoContextMenu(null); }}><FilePenLine size={14} /><span>{selection.selectedIds.size > 1 ? '批量重命名…' : '重命名…'}</span></button><button type="button" role="menuitem" onClick={() => { void openFolderDialog('copy'); setPhotoContextMenu(null); }}><Copy size={14} /><span>复制到文件夹…</span></button><button type="button" role="menuitem" onClick={() => { void openFolderDialog('move'); setPhotoContextMenu(null); }}><FolderInput size={14} /><span>移动到文件夹…</span></button></>}
        {!isDemo && catalogAlbums.length > 0 && <div className="photo-menu-album"><FolderHeart size={14} /><select aria-label="加入相册" value={albumTargetId} onChange={(event) => setAlbumTargetId(event.target.value)}><option value="">加入相册…</option>{catalogAlbums.map((album) => <option key={album.id} value={album.id}>{album.name}</option>)}</select><button type="button" disabled={!albumTargetId} onClick={() => { void updateAlbumMembership('add', albumTargetId); setPhotoContextMenu(null); }}>加入</button></div>}
        {!isDemo && selectedAlbumId && <button type="button" role="menuitem" onClick={() => { void updateAlbumMembership('remove'); setPhotoContextMenu(null); }}><FolderHeart size={14} /><span>从当前相册移出</span></button>}
        {!isDemo && <><span className="folder-menu-separator" /><button type="button" role="menuitem" onClick={() => { setRemovalMode('remove'); setPhotoContextMenu(null); }}><LibraryBig size={14} /><span>从图库移除…</span></button><button className="is-danger" type="button" role="menuitem" onClick={() => { setRemovalMode('trash'); setPhotoContextMenu(null); }}><Trash2 size={14} /><span>移到系统回收站…</span></button></>}
      </div>}
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

type WorkflowStage = 'analysis' | 'collection' | 'optimization' | 'prompt' | 'generation' | 'review';
type WorkflowRule = { id: string; text: string; enabled: boolean };
type AgentPlan = { summary: string; steps: string[]; requestedCount: number | undefined; style: string | undefined; outputFolder: string | undefined };
type WorkflowAssetMeta = { id: string; fileName: string; src: string; thumbnailSrc?: string; format: string };
type CollectionReport = { summary: string; groups: string[][]; keep: string[]; review: string[]; recommendations: string[] };
type WorkflowDraft = {
  workflowAssetIds: string[];
  workflowAssetMeta: Record<string, WorkflowAssetMeta>;
  stage: WorkflowStage;
  templateId: string;
  generationCount: number;
  globalRules: WorkflowRule[];
  itemRules: Record<string, WorkflowRule[]>;
  itemTemplateIds: Record<string, string>;
  itemGenerationCounts: Record<string, number>;
  collectionReport: CollectionReport | null;
};
const WORKFLOW_DRAFT_KEY = 'photoallisai.ai-workflow.v1';
const DEFAULT_WORKFLOW_RULES: WorkflowRule[] = [
  { id: 'identity', text: '保持人物身份、脸部特征和年龄不变', enabled: true },
  { id: 'composition', text: '保持原始构图、镜头视角和主体数量', enabled: true },
  { id: 'texture', text: '保留真实皮肤纹理，避免塑料感', enabled: true },
  { id: 'scene', text: '不改变主要场景和关键物体', enabled: true }
];

function buildAgentPlan(instruction: string, photoCount: number): AgentPlan {
  const text = instruction.trim();
  const countMatch = text.match(/(?:最好看|选|选择|保留|挑选)\s*(?:的)?\s*(\d+)\s*张/);
  const requestedCount = countMatch ? clamp(Number(countMatch[1]), 1, Math.max(photoCount, 1)) : undefined;
  const style = /动漫|anime|二次元/i.test(text) ? '动漫风' : /电影|cinematic/i.test(text) ? '电影感' : undefined;
  const folderMatch = text.match(/(?:存到|保存到|输出到|目录下的)\s*[“”"']?([^，。,\.\s]+)[“”"']?文件夹/);
  const outputFolder = folderMatch?.[1];
  const steps = [
    /糊|模糊|相似|重复/.test(text) ? '识别并移除模糊或高度相似的照片候选' : '分析照片质量、构图和主体表现',
    requestedCount ? `按视觉质量挑选 ${requestedCount} 张并设置为 2 星` : '按视觉质量分组并设置评分',
    /9\s*张|三颗|3\s*星/.test(text) ? '从精选结果中挑选最佳 9 张并设置为 3 星' : '为重点照片生成修图任务',
    style ? `应用${style}风格并保留主体身份与构图` : '按整体提示词执行 AI 修图',
    outputFolder ? `将结果输出到“${outputFolder}”文件夹` : '保留在应用管理的生成结果中'
  ];
  return { summary: text || '请描述你希望 Agent 如何筛选、评分和修图照片。', steps, requestedCount, style, outputFolder };
}

function loadWorkflowDraft(): WorkflowDraft {
  const fallback: WorkflowDraft = { workflowAssetIds: [], workflowAssetMeta: {}, stage: 'analysis', templateId: '', generationCount: 1, globalRules: DEFAULT_WORKFLOW_RULES, itemRules: {}, itemTemplateIds: {}, itemGenerationCounts: {}, collectionReport: null };
  try {
    const value = JSON.parse(window.localStorage.getItem(WORKFLOW_DRAFT_KEY) ?? '') as Partial<WorkflowDraft>;
    const stages: WorkflowStage[] = ['analysis', 'collection', 'optimization', 'prompt', 'generation', 'review'];
    const validRules = (rules: unknown): rules is WorkflowRule[] => Array.isArray(rules) && rules.length <= 100 && rules.every((rule) => typeof rule === 'object' && rule !== null && typeof (rule as WorkflowRule).id === 'string' && typeof (rule as WorkflowRule).text === 'string' && typeof (rule as WorkflowRule).enabled === 'boolean');
    return {
      workflowAssetIds: Array.isArray(value.workflowAssetIds) ? value.workflowAssetIds.filter((id): id is string => typeof id === 'string').slice(0, 10_000) : fallback.workflowAssetIds,
      workflowAssetMeta: value.workflowAssetMeta && typeof value.workflowAssetMeta === 'object' ? Object.fromEntries(Object.entries(value.workflowAssetMeta).filter(([, item]) => typeof item === 'object' && item !== null && typeof (item as WorkflowAssetMeta).id === 'string' && typeof (item as WorkflowAssetMeta).fileName === 'string' && typeof (item as WorkflowAssetMeta).src === 'string' && typeof (item as WorkflowAssetMeta).format === 'string').slice(0, 10_000)) as Record<string, WorkflowAssetMeta> : fallback.workflowAssetMeta,
      stage: stages.includes(value.stage as WorkflowStage) ? value.stage as WorkflowStage : fallback.stage,
      templateId: typeof value.templateId === 'string' ? value.templateId : '',
      generationCount: clamp(Number(value.generationCount) || 1, 1, 8),
      globalRules: validRules(value.globalRules) ? value.globalRules : fallback.globalRules,
      itemRules: value.itemRules && typeof value.itemRules === 'object' ? Object.fromEntries(Object.entries(value.itemRules).filter(([, rules]) => validRules(rules))) : {},
      itemTemplateIds: value.itemTemplateIds && typeof value.itemTemplateIds === 'object' ? Object.fromEntries(Object.entries(value.itemTemplateIds).filter(([, id]) => typeof id === 'string')) as Record<string, string> : {},
      itemGenerationCounts: value.itemGenerationCounts && typeof value.itemGenerationCounts === 'object' ? Object.fromEntries(Object.entries(value.itemGenerationCounts).filter(([, count]) => Number.isInteger(count) && Number(count) >= 1 && Number(count) <= 8)) as Record<string, number> : {},
      collectionReport: value.collectionReport && typeof value.collectionReport.summary === 'string' && Array.isArray(value.collectionReport.groups) && Array.isArray(value.collectionReport.keep) && Array.isArray(value.collectionReport.review) && Array.isArray(value.collectionReport.recommendations) ? value.collectionReport : null
    };
  } catch {
    return fallback;
  }
}

function AgentBatchPage({ photos: availablePhotos, selectedIds, focusId, onOpenBatch }: { photos: Photo[]; selectedIds: ReadonlySet<string>; focusId: string | null; onOpenBatch: () => void }): React.JSX.Element {
  const [instruction, setInstruction] = useState('');
  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [steps, setSteps] = useState<string[]>([]);
  const selectedPhotos = availablePhotos.filter((photo) => selectedIds.has(photo.id));
  const focused = availablePhotos.find((photo) => photo.id === focusId);
  const start = () => {
    const sourceCount = selectedPhotos.length;
    const nextSteps = [`已接收 ${sourceCount} 张照片${focused ? `，焦点为 ${focused.fileName}` : ''}`, 'Agent 正在根据目标动态选择工具', '等待任务回执后显示实际影响范围'];
    setSteps(nextSteps);
    setExpanded(null);
    setRunning(true);
    setNotice('已创建 Agent 批处理计划，执行前会展示影响范围。');
  };
  return <main className="agent-page">
    <header className="agent-page-header"><div><span className="workflow-agent-kicker"><Bot size={14} />Agent 批处理</span><h1>描述目标，交给 Agent 处理</h1><p>Agent 会使用当前选择上下文，并在每一步提供可展开的处理依据。</p></div><div className="agent-context-badge"><strong>{selectedPhotos.length}</strong><span>张当前选择</span></div></header>
    <section className="agent-input-section"><div className="agent-context-line"><span>输入范围</span><strong>{selectedPhotos.length ? `当前选择的 ${selectedPhotos.length} 张照片` : '尚未选择照片'}</strong>{focused && <em>焦点：{focused.fileName}</em>}</div><textarea aria-label="Agent 批处理指令" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：处理选中图片，找出最清晰的照片，加上精选标签并导出。" /><div className="agent-input-footer"><span>支持整理、筛选、评分、标签、修图、导出等批处理任务</span><button className="primary-action" type="button" disabled={!instruction.trim() || selectedPhotos.length === 0 || running} onClick={start}><Sparkles size={15} />{running ? '处理中…' : '开始处理'}</button></div></section>
    {notice && <p className="agent-notice" role="status">{notice}</p>}
    {steps.length > 0 && <section className="agent-steps-section"><div className="agent-section-heading"><div><span>处理详情</span><h2>Agent 执行记录</h2></div><button className="quiet-button compact" type="button" onClick={onOpenBatch}><WandSparkles size={12} />转到 AI 批量修图</button></div>{steps.map((step, index) => <article className={`agent-step-row${expanded === index ? ' is-expanded' : ''}`} key={step}><button type="button" onClick={() => setExpanded(expanded === index ? null : index)}><span className="agent-step-index">{index + 1}</span><span><strong>{step}</strong><small>{expanded === index ? '已展开详细信息' : '点击查看处理依据'}</small></span><ChevronDown size={14} /></button>{expanded === index && <div className="agent-step-detail">当前步骤会记录输入资源、判断依据、受影响的照片和执行结果。完成真实任务后，这里将显示逐项文件与模型响应摘要。</div>}</article>)}</section>}
  </main>;
}

function AgentDockPanel({ selectedIds, photos, onClose, onOpenBatch, onCollapse, onMove }: { selectedIds: ReadonlySet<string>; photos: Photo[]; onClose: () => void; onOpenBatch: () => void; onCollapse: () => void; onMove: () => void }): React.JSX.Element {
  const selected = photos.filter((photo) => selectedIds.has(photo.id));
  const [instruction, setInstruction] = useState('');
  const [messages, setMessages] = useState<Array<{ text: string; detail?: string; state?: 'running' | 'done' | 'error' }>>([]);
  const [pendingConfirmation, setPendingConfirmation] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const runInstruction = async (text: string, confirmed: boolean) => {
    if (!text || selected.length === 0) return;
    const wantsGenerate = /修图|调色|动漫|风格|生成/.test(text);
    const wantsRate = /评分|星级|标为[0-5一二三四五星]/.test(text);
    const wantsTag = /标签|标记|精选|收藏/.test(text);
    const wantsDelete = /删除|移除|丢弃/.test(text);
    const highImpact = wantsDelete || /移动|导出|回收站/.test(text);
    const operations = [
      ...(wantsRate ? [{ kind: 'rate', label: '修改评分' }] : []),
      ...(wantsTag ? [{ kind: 'adjust', label: '修改标签' }] : []),
      ...(wantsGenerate ? [{ kind: 'generate', label: '创建 AI 生成任务' }] : []),
      ...(wantsDelete ? [{ kind: 'delete', label: '移出图库' }] : [])
    ];
    if (/相似|重复|糊|模糊/.test(text)) operations.unshift({ kind: 'deduplicate', label: '筛选图片' });
    if (operations.length === 0) {
      setMessages([{ text: '需要更多信息', detail: '我还不能把这条要求映射到可执行操作。请说明要处理的照片范围和期望结果。', state: 'error' }]);
      return;
    }
    setMessages(operations.map((operation) => ({ text: operation.label, detail: highImpact ? '等待确认' : '正在执行', state: highImpact ? 'done' : 'running' })));
    setPendingConfirmation(highImpact && !confirmed ? text : null);
    setInstruction('');
    try {
      const profiles = wantsGenerate ? await window.desktopApi.listProviderProfiles() : [];
      const generationProfile = profiles.find((profile) => profile.purpose === 'generation' && profile.enabled);
      if (wantsGenerate && !generationProfile) {
        setMessages([{ text: '检查生成模型配置', detail: '没有启用的生成模型，请先到设置中配置 Provider。', state: 'error' }]);
        return;
      }
      const task = await window.desktopApi.enqueueTask({
        kind: 'agent',
        assetId: null,
        payload: {
          instruction: text,
          globalPrompt: text,
          selection: { assetIds: selected.map((photo) => photo.id), rankingInstruction: '' },
          perAssetPrompts: [],
          steps: operations.map((operation, index) => ({
            id: `operation-${index + 1}`,
            kind: operation.kind,
            instruction: text,
            prompt: '',
            perAssetPrompts: [],
            providerProfileId: operation.kind === 'generate' ? generationProfile?.id ?? null : null,
            templateId: null,
            outputDirectory: null,
            targetFolderId: null,
            confirm: confirmed,
            rating: operation.kind === 'rate' ? (text.match(/([0-5一二三四五])\s*星/u)?.[1] === '2' ? 2 : 2) : undefined,
            style: operation.kind === 'adjust' ? 'Agent 处理' : null,
            dependsOn: index > 0 ? [`operation-${index}`] : []
          })),
          dryRun: false,
          confirmHighImpact: confirmed,
          planVersion: 1
        }
      });
      setMessages([{ text: '已提交 Agent 任务', detail: `任务 ${task.id} 已进入任务中心。`, state: 'running' }]);
      const poll = async () => {
        const current = await window.desktopApi.getTask(task.id);
        if (!current) return;
        if (current.status === 'completed' && current.result) {
          const result = current.result as { completedSteps?: string[]; skippedSteps?: string[]; warnings?: string[]; generatedResultIds?: string[]; removedAssetIds?: string[]; movedAssetIds?: string[] };
          const completed = result.completedSteps?.length ?? 0;
          const generated = result.generatedResultIds?.length ?? 0;
          const warnings = result.warnings?.length ?? 0;
          setMessages([{ text: 'Agent 任务已完成', detail: `${completed} 项完成${generated ? ` · 生成 ${generated} 个版本` : ''}${warnings ? ` · ${warnings} 条提示` : ''}`, state: warnings ? 'error' : 'done' }]);
        } else if (['failed', 'canceled'].includes(current.status)) {
          setMessages([{ text: current.status === 'failed' ? 'Agent 任务失败' : 'Agent 任务已取消', detail: current.errorCode ?? '请在任务中心查看详细信息。', state: 'error' }]);
        } else {
          window.setTimeout(() => void poll(), 900);
        }
      };
      void poll();
    } catch (error) {
      setMessages([{ text: '执行失败', detail: String(error), state: 'error' }]);
    }
  };
  const submit = (event: React.FormEvent) => { event.preventDefault(); void runInstruction(instruction.trim(), false); };
  return <aside className="agent-dock-panel">
    <header className="agent-dock-header"><Bot size={15} /><div><strong>Agent 批处理</strong><span>当前选择 {selected.length} 张</span></div><button type="button" aria-label="调整 Agent 面板顺序" onClick={onMove}><ArrowUp size={12} /></button><button type="button" aria-label="折叠 Agent 面板" onClick={onCollapse}><ChevronDown size={14} /></button><button type="button" aria-label="关闭 Agent 批处理" onClick={onClose}><X size={14} /></button></header>
    <div className="agent-dock-context"><strong>{selected.length} 张</strong><span>当前选择</span></div>
    <div className="agent-dock-messages"><div className="agent-dock-message">输入目标，Agent 会执行并记录结果。</div>{messages.map((message, index) => <button className={`agent-dock-message agent-dock-step ${message.state ?? ''}`} type="button" key={`${message.text}-${index}`} onClick={() => setExpanded(expanded === index ? null : index)}><span><strong>{index + 1}. {message.text}</strong>{expanded === index && <small>{message.detail ?? '步骤正在执行。'}</small>}</span><ChevronDown size={12} /></button>)}</div>
    {pendingConfirmation && <div className="agent-dock-confirm"><span>包含文件操作，确认后执行</span><button className="primary-action compact" type="button" onClick={() => { const instructionToConfirm = pendingConfirmation; setPendingConfirmation(null); void runInstruction(instructionToConfirm, true); }}>确认执行</button></div>}
    <form className="agent-dock-input" onSubmit={(event) => void submit(event)}><textarea aria-label="Agent 输入" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：处理选中图片，挑出最好的 9 张并进行动漫风修图" /><button type="submit" aria-label="发送 Agent 指令" disabled={!instruction.trim() || selected.length === 0}><Sparkles size={14} /></button></form>
    <footer className="agent-dock-footer"><button className="quiet-button compact" type="button" onClick={onOpenBatch}>打开批量修图</button></footer>
  </aside>;
}

function BatchEditSidebar({ selectedIds, photos, onOpenTemplates }: { selectedIds: ReadonlySet<string>; photos: Photo[]; onOpenTemplates: () => void }): React.JSX.Element {
  const selected = photos.filter((photo) => selectedIds.has(photo.id));
  const [prompt, setPrompt] = useState('');
  return <aside className="tool-sidebar batch-sidebar"><header className="tool-sidebar-header"><Sparkles size={15} /><div><strong>AI 批量修图</strong><span>模板驱动生成</span></div></header><div className="tool-sidebar-scroll"><section className="tool-sidebar-section"><div className="tool-sidebar-label">当前照片</div><div className="tool-sidebar-count"><strong>{selected.length}</strong><span>张照片</span></div></section><section className="tool-sidebar-section"><div className="tool-sidebar-label">批次整体提示词</div><textarea aria-label="批次整体提示词" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述这一批照片的共同修图要求" /></section><section className="tool-sidebar-section"><div className="tool-sidebar-label">模板</div><button className="quiet-button compact tool-sidebar-wide-button" type="button" onClick={onOpenTemplates}><WandSparkles size={12} />从模板库选择</button></section><section className="tool-sidebar-section tool-sidebar-muted"><p>每张照片的单独提示词和最终 Prompt 在批量修图工作区中编辑。</p></section></div><footer className="tool-sidebar-footer"><button className="primary-action compact" type="button" disabled={selected.length === 0}>开始批量修图</button></footer></aside>;
}

function AiWorkflowPage({ photos: availablePhotos, selectedIds, focusId, workflowAssetIds, workflowAssetMeta, tasks, globalRules, onGlobalRulesChange, templateId, onAddAssets, onRemoveAsset, onMoveAsset, onClearAssets, onOpenTasks, onFocusAsset, onOpenViewer }: { photos: Photo[]; selectedIds: ReadonlySet<string>; focusId: string | null; workflowAssetIds: string[]; workflowAssetMeta: Record<string, WorkflowAssetMeta>; tasks: PersistedTask[]; globalRules: WorkflowRule[]; onGlobalRulesChange: React.Dispatch<React.SetStateAction<WorkflowRule[]>>; templateId: string; onAddAssets: (ids: string[]) => void; onRemoveAsset: (id: string) => void; onMoveAsset: (id: string, direction: -1 | 1) => void; onClearAssets: () => void; onOpenTasks: () => void; onFocusAsset: (id: string) => void; onOpenViewer: (assetId: string, assetIds?: string[], resultId?: string | null) => void }): React.JSX.Element {
  const initialDraft = useMemo(loadWorkflowDraft, []);
  const [stage, setStage] = useState<WorkflowStage>(initialDraft.stage);
  const [revisions, setRevisions] = useState<Record<string, AnalysisRevision | undefined>>({});
  const revisionPollOffset = useRef(0);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [storageMode, setStorageMode] = useState<AppSettings['generationStorageMode']>('managed');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [collectionReport, setCollectionReport] = useState<CollectionReport | null>(initialDraft.collectionReport);
  const [generationCount, setGenerationCount] = useState(initialDraft.generationCount);
  const [itemTemplateIds, setItemTemplateIds] = useState<Record<string, string>>(initialDraft.itemTemplateIds);
  const [itemGenerationCounts, setItemGenerationCounts] = useState<Record<string, number>>(initialDraft.itemGenerationCounts);
  const [localFocusId, setLocalFocusId] = useState<string | null>(focusId);
  const [itemRules, setItemRules] = useState<Record<string, WorkflowRule[]>>(initialDraft.itemRules);
  const [agentInstruction, setAgentInstruction] = useState('');
  const [agentPlan, setAgentPlan] = useState<AgentPlan | null>(null);
  const ids = workflowAssetIds;
  const idsKey = ids.join('|');
  const analysisTasks = useMemo(() => {
    const latest = new Map<string, PersistedTask>();
    for (const task of tasks) if (task.kind === 'analysis' && task.assetId && !latest.has(task.assetId)) latest.set(task.assetId, task);
    return latest;
  }, [tasks]);
  const completedKey = ids.map((id) => analysisTasks.get(id)?.status === 'completed' ? analysisTasks.get(id)?.id : '').join('|');
  const workflowPhotos = ids.map((id) => {
    const visible = availablePhotos.find((photo) => photo.id === id);
    if (visible) return visible;
    const saved = workflowAssetMeta[id];
    return saved ? { ...saved, dimensions: '', rating: 0 } : null;
  }).filter((photo): photo is Photo => Boolean(photo));
  const currentId = focusId && ids.includes(focusId) ? focusId : workflowPhotos[0]?.id ?? null;
  const effectiveCurrentId = localFocusId && ids.includes(localFocusId) ? localFocusId : currentId;
  const currentPhoto = effectiveCurrentId ? workflowPhotos.find((photo) => photo.id === effectiveCurrentId) ?? null : null;
  const currentRevision = effectiveCurrentId ? revisions[effectiveCurrentId] : undefined;
  const [generationResults, setGenerationResults] = useState<Record<string, GenerationResult[]>>({});
  const [bestResultIds, setBestResultIds] = useState<Record<string, string>>({});
  const [batchContextMenu, setBatchContextMenu] = useState<{ x: number; y: number; assetId: string; resultId?: string } | null>(null);

  useEffect(() => {
    void Promise.all([window.desktopApi.listProviderProfiles(), window.desktopApi.listPromptTemplates(), window.desktopApi.getAppSettings()]).then(([items, savedTemplates, settings]) => {
      setProfiles(items);
      setTemplates(savedTemplates);
      setStorageMode(settings.generationStorageMode);
    });
  }, []);
  useEffect(() => {
    let active = true;
    if (ids.length === 0) { setRevisions({}); return () => { active = false; }; }
    void Promise.all(ids.map(async (id) => [id, (await window.desktopApi.listAnalysisRevisions(id))[0]] as const)).then((items) => {
      if (active) setRevisions(Object.fromEntries(items));
    }).catch(() => { if (active) setNotice('读取视觉识别结果失败，请重试。'); });
    return () => { active = false; };
  }, [ids, idsKey, completedKey]);
  useEffect(() => {
    let active = true;
    void Promise.all(ids.map(async (id) => [id, await window.desktopApi.listGenerationResults(id)] as const)).then((entries) => {
      if (active) setGenerationResults(Object.fromEntries(entries));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [ids, idsKey, tasks]);
  useEffect(() => {
    if (ids.length === 0) return;
    let active = true;
    const refreshPending = () => {
      const pending = ids.filter((id) => !revisions[id]);
      if (pending.length === 0) return;
      const batch = Array.from({ length: Math.min(20, pending.length) }, (_, index) => pending[(revisionPollOffset.current + index) % pending.length]!);
      revisionPollOffset.current = (revisionPollOffset.current + batch.length) % pending.length;
      void Promise.all(batch.map(async (id) => [id, (await window.desktopApi.listAnalysisRevisions(id))[0]] as const)).then((items) => {
        if (!active) return;
        const completed = items.filter((entry): entry is readonly [string, AnalysisRevision] => Boolean(entry[1]));
        if (completed.length) setRevisions((current) => ({ ...current, ...Object.fromEntries(completed) }));
      }).catch(() => undefined);
    };
    const interval = window.setInterval(refreshPending, 3_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [ids, idsKey, revisions]);
  useEffect(() => { if (focusId && ids.includes(focusId)) setLocalFocusId(focusId); }, [focusId, ids, idsKey]);
  useEffect(() => {
    if (!effectiveCurrentId || !currentRevision) return;
    setItemRules((current) => current[effectiveCurrentId] ? current : {
      ...current,
      [effectiveCurrentId]: currentRevision.result.generativeActions.map((action) => ({ id: action.id, text: `${action.target}：${action.instruction}`, enabled: action.enabled }))
    });
  }, [effectiveCurrentId, currentRevision]);
  useEffect(() => {
    const timeout = window.setTimeout(() => window.localStorage.setItem(WORKFLOW_DRAFT_KEY, JSON.stringify({ workflowAssetIds, workflowAssetMeta, stage, templateId, generationCount, globalRules, itemRules, itemTemplateIds, itemGenerationCounts, collectionReport, agentInstruction, agentPlan })), 300);
    return () => window.clearTimeout(timeout);
  }, [agentInstruction, agentPlan, collectionReport, generationCount, globalRules, itemGenerationCounts, itemRules, itemTemplateIds, stage, templateId, workflowAssetIds, workflowAssetMeta]);
  useEffect(() => {
    try { window.localStorage.setItem(`${WORKFLOW_DRAFT_KEY}.best-results`, JSON.stringify(bestResultIds)); } catch { /* draft remains usable in memory */ }
  }, [bestResultIds]);

  const analyze = async () => {
    const profile = profiles.find((item) => item.purpose === 'vision' && item.enabled);
    if (!profile) { setNotice('请先在设置中配置并启用视觉分析模型。'); return; }
    if (ids.length === 0) { setNotice('请先从图库或看图加入照片到处理队列。'); return; }
    setBusy(true); setNotice('正在加入视觉分析队列…');
    try {
      const batchId = crypto.randomUUID();
      for (const assetId of ids) {
        await window.desktopApi.enqueueTask({ kind: 'analysis', assetId, payload: { providerProfileId: profile.id, mode: 'full', batchId, locale: getLocale() } });
      }
      setNotice(`已加入 ${ids.length} 张照片的分析任务。`); setStage('optimization');
    } finally { setBusy(false); }
  };
  const planAgent = () => {
    const plan = buildAgentPlan(agentInstruction, workflowPhotos.length);
    setAgentPlan(plan);
    if (plan.style && !globalRules.some((rule) => rule.text.includes(plan.style!))) {
      setNotice(`已生成 Agent 计划：将应用${plan.style}风格。`);
    } else {
      setNotice('已生成 Agent 执行计划，请确认后开始。');
    }
  };
  const applyAgentPlan = () => {
    const plan = agentPlan ?? buildAgentPlan(agentInstruction, workflowPhotos.length);
    setAgentPlan(plan);
    const additions = [
      /糊|模糊/.test(agentInstruction) ? '排除模糊、失焦或严重曝光异常的照片' : '',
      /相似|重复/.test(agentInstruction) ? '删除或跳过高度相似的重复照片' : '',
      plan.style ? `整体风格：${plan.style}` : '',
      plan.outputFolder ? `输出目录：${plan.outputFolder}` : ''
    ].filter(Boolean);
    if (additions.length) onGlobalRulesChange((current) => [...current.filter((rule) => !additions.some((item) => rule.text === item)), ...additions.map((text) => ({ id: crypto.randomUUID(), text, enabled: true }))]);
    if (plan.requestedCount) setGenerationCount(1);
    setStage('analysis');
    setNotice('Agent 计划已应用到工作流。请检查整体提示词与逐图提示词后执行。');
  };
  const generate = async () => {
    const profile = profiles.find((item) => item.purpose === 'generation' && item.enabled);
    if (!profile) { setNotice('请先在设置中配置并启用图片生成模型。'); return; }
    const usable = ids.map((assetId) => ({ assetId, revision: revisions[assetId] })).filter((item): item is { assetId: string; revision: AnalysisRevision } => Boolean(item.revision));
    if (usable.length === 0) { setNotice('请先完成视觉分析，再生成提示词和图片。'); setStage('analysis'); return; }
    setBusy(true); setNotice('正在创建提示词并加入生图队列…');
    try {
      const submissionId = crypto.randomUUID();
      for (const { assetId, revision } of usable) {
        const selectedTemplateId = itemTemplateIds[assetId] || templateId;
        const template = templates.find((item) => item.id === selectedTemplateId) ?? null;
        const enabled = (itemRules[assetId] ?? []).filter((item) => item.enabled).map((item) => item.text);
        const rules = globalRules.filter((item) => item.enabled).map((item) => item.text);
        const prompt = composeGenerationPrompt({ templateBody: template?.body ?? DEFAULT_GENERATION_TEMPLATE_BODY, analysis: { ...revision.result, generativeActions: revision.result.generativeActions.filter((action) => enabled.some((item) => item.startsWith(`${action.target}：`))) }, userInstruction: [...rules, ...enabled].join('\n') });
        const batchId = crypto.randomUUID();
        const count = itemGenerationCounts[assetId] ?? generationCount;
        for (let resultIndex = 1; resultIndex <= count; resultIndex += 1) await window.desktopApi.enqueueTask({ kind: 'generation', assetId, payload: { providerProfileId: profile.id, batchId, submissionId, prompt, templateId: template?.id ?? null, templateVersion: template?.version ?? null, resultIndex, storageMode, analysisRevisionId: revision.id, disabledActionIds: revision.result.generativeActions.filter((action) => !enabled.some((item) => item.startsWith(`${action.target}：`))).map((action) => action.id), userInstruction: [...rules, ...enabled].join('\n') } });
      }
      const taskCount = usable.reduce((sum, item) => sum + (itemGenerationCounts[item.assetId] ?? generationCount), 0);
      setNotice(`已将 ${usable.length} 张照片、共 ${taskCount} 个版本加入生图队列。`); setStage('review');
    } finally { setBusy(false); }
  };
  const analyzeCollection = async () => {
    const analyzed = workflowPhotos.map((photo) => ({ photo, revision: revisions[photo.id] })).filter((item): item is { photo: Photo; revision: AnalysisRevision } => Boolean(item.revision));
    if (analyzed.length < 2) { setNotice('处理队列中至少完成两张照片的视觉识别后，才能进行相册横向分析。'); return; }
    const profile = profiles.find((item) => item.purpose === 'vision' && item.enabled);
    if (!profile) { setNotice('请先在设置中配置并启用视觉分析模型。'); return; }
    setBusy(true);
    setNotice('相册分析已加入任务队列。');
    try {
      const task = await window.desktopApi.enqueueTask({ kind: 'collection-analysis', assetId: null, payload: { providerProfileId: profile.id, assetIds: analyzed.map((item) => item.photo.id) } });
      let completed: PersistedTask | null = task;
      while (completed && !['completed', 'failed', 'canceled'].includes(completed.status)) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        completed = await window.desktopApi.getTask(task.id);
      }
      if (!completed || completed.status !== 'completed') throw new Error(completed?.errorCode ?? 'COLLECTION_ANALYSIS_FAILED');
      const report = collectionAnalysisReportSchema.parse(completed.result);
      const names = new Map(workflowPhotos.map((photo) => [photo.id, photo.fileName]));
      setCollectionReport({
        summary: report.summary,
        groups: report.groups.map((group) => group.assetIds.map((id) => names.get(id) ?? id)),
        keep: report.keepAssetIds.map((id) => names.get(id) ?? id),
        review: report.reviewAssetIds.map((id) => names.get(id) ?? id),
        recommendations: report.recommendations
      });
      setNotice(`已完成 ${analyzed.length} 张照片的相册分析。`);
    } catch {
      setNotice('相册分析失败，请在任务中心查看错误并重试。');
    } finally {
      setBusy(false);
    }
  };
  return <main className="ai-workflow-page batch-workspace" onFocusCapture={(event) => { const target = (event.target as HTMLElement).closest<HTMLElement>('[data-workflow-asset-id]'); const id = target?.dataset.workflowAssetId; if (id) { setLocalFocusId(id); onFocusAsset(id); } }}>
    <div className="workflow-body">
      <section className="workflow-main">
        <section className="batch-prompt-card"><div><span>批次整体提示词</span></div><textarea aria-label="批次整体提示词" value={globalRules.filter((item) => item.enabled).map((item) => item.text).join('\n')} onChange={(event) => onGlobalRulesChange([{ id: 'batch-prompt', text: event.target.value, enabled: true }])} placeholder="描述所有照片共有的修图要求" /></section>
        <div className="batch-queue-toolbar"><strong>处理队列 <span>{workflowPhotos.length} 张</span></strong><div className="batch-queue-toolbar-actions"><label><span>默认生成</span><input aria-label="默认生成数量" type="number" min="1" max="8" value={generationCount} onChange={(event) => setGenerationCount(clamp(Number(event.target.value) || 1, 1, 8))} /></label><button className="quiet-button compact" type="button" disabled={busy || workflowPhotos.length === 0} onClick={() => void analyze()}><Sparkles size={12} />识别</button><button className="primary-action compact" type="button" disabled={busy || workflowPhotos.length === 0} onClick={() => void generate()}><WandSparkles size={12} />生成全部</button><button className="quiet-button compact" type="button" onClick={onOpenTasks}><Clock3 size={12} />任务</button><button className="quiet-button compact" type="button" disabled={selectedIds.size === 0} onClick={() => onAddAssets([...selectedIds])}><Plus size={12} /></button><button className="quiet-button compact" type="button" disabled={workflowAssetIds.length === 0} onClick={onClearAssets}><X size={12} /></button></div></div>
        {stage === 'analysis' && <div className="workflow-analysis">
          <div className="workflow-analysis-counts"><span>已识别 {workflowPhotos.filter((photo) => revisions[photo.id]).length}</span><span>处理中 {workflowPhotos.filter((photo) => !revisions[photo.id] && analysisTasks.get(photo.id) && !['failed', 'canceled', 'completed'].includes(analysisTasks.get(photo.id)!.status)).length}</span><span>待识别 {workflowPhotos.filter((photo) => !revisions[photo.id] && !analysisTasks.has(photo.id)).length}</span></div>
        </div>}
        {workflowPhotos.length === 0 ? <div className="workflow-empty">从图库或看图将照片加入处理队列</div> : <div className="batch-queue-list">{workflowPhotos.map((photo, index) => {
            const result = revisions[photo.id]?.result;
            const task = analysisTasks.get(photo.id);
            const state = task?.status === 'failed' ? <AnalysisFailure code={task.errorCode} taskId={task.id} /> : result ? '已识别' : task?.status === 'canceled' ? '已取消' : task?.status === 'queued' ? '排队中' : task ? task.status === 'completed' ? '读取结果中' : '识别中' : '待识别';
            const candidates = generationResults[photo.id] ?? [];
            return <article className={`batch-queue-item${photo.id === effectiveCurrentId ? ' is-active' : ''}`} data-workflow-asset-id={photo.id} key={photo.id} onClick={() => { setLocalFocusId(photo.id); onFocusAsset(photo.id); }} onContextMenu={(event) => { event.preventDefault(); setLocalFocusId(photo.id); onFocusAsset(photo.id); setBatchContextMenu({ x: event.clientX, y: event.clientY, assetId: photo.id }); }}><div className="batch-queue-source" onDoubleClick={() => onOpenViewer(photo.id, workflowAssetIds)}><span className="batch-queue-original">{photo.thumbnailSrc || photo.src ? <img src={photo.thumbnailSrc ?? photo.src} alt="" /> : <Image size={20} />}<small>原图</small></span><span className="batch-queue-file"><strong>{photo.fileName}</strong><em>{state}</em></span></div><div className="batch-queue-editor"><label><span>本图提示词</span><textarea value={(itemRules[photo.id] ?? []).filter((rule) => rule.enabled).map((rule) => rule.text).join('\n')} onClick={(event) => event.stopPropagation()} onChange={(event) => setItemRules((current) => ({ ...current, [photo.id]: [{ id: `prompt-${photo.id}`, text: event.target.value, enabled: true }] }))} placeholder="覆盖批次提示词，描述这张图的独立要求" /></label><label><span>生成数量</span><input type="number" min="1" max="8" value={itemGenerationCounts[photo.id] ?? generationCount} onClick={(event) => event.stopPropagation()} onChange={(event) => setItemGenerationCounts((current) => ({ ...current, [photo.id]: clamp(Number(event.target.value) || 1, 1, 8) }))} /></label></div><div className="batch-queue-candidates">{candidates.slice(0, 8).map((candidate) => <button className={`batch-candidate${bestResultIds[photo.id] === candidate.id || candidate.reviewState === 'preferred' ? ' is-best' : ''}`} type="button" key={candidate.id} title="单击设为最佳，双击打开大图" onClick={(event) => { event.stopPropagation(); setBestResultIds((current) => ({ ...current, [photo.id]: candidate.id })); void window.desktopApi.updateGenerationResultReview({ resultId: candidate.id, reviewState: 'preferred' }); }} onDoubleClick={(event) => { event.stopPropagation(); onOpenViewer(photo.id, workflowAssetIds, candidate.id); }}><img src={candidate.resultUrl} alt={`生成候选 ${candidate.version}`} /><small>{bestResultIds[photo.id] === candidate.id || candidate.reviewState === 'preferred' ? '最佳' : `V${candidate.version}`}</small></button>)}</div><div className="batch-queue-meta"><span>{result?.catalog.shortDescription ?? result?.summary ?? '尚未生成视觉分析结果'}</span><div><button type="button" aria-label={`重试 ${photo.fileName}`} onClick={(event) => { event.stopPropagation(); setLocalFocusId(photo.id); onFocusAsset(photo.id); void generate(); }}><RotateCcw size={12} /></button><button type="button" aria-label={`移除 ${photo.fileName}`} onClick={(event) => { event.stopPropagation(); onRemoveAsset(photo.id); }}><X size={12} /></button></div></div></article>;
            /* legacy analysis details remain available below the compact batch row */
            /* <button className="workflow-analysis-select" type="button" onClick={() => { setLocalFocusId(photo.id); onFocusAsset(photo.id); }}>
              <span className="workflow-analysis-thumb">{photo.thumbnailSrc || photo.src ? <img src={photo.thumbnailSrc ?? photo.src} alt="" /> : <Image size={20} />}</span>
              <span className="workflow-analysis-content"><span className="workflow-analysis-title"><strong>{photo.fileName}</strong><em>{state}</em>{result && <b>{Math.round(result.quality.overallScore)} 分</b>}</span><span className="workflow-analysis-description">{result?.catalog.shortDescription ?? result?.summary ?? (task?.status === 'failed' ? '识别失败，可在任务中心重试' : '')}</span>{result && <span className="workflow-analysis-issues">{result.quality.issues.length ? result.quality.issues.slice(0, 3).map((issue) => issue.description).join(' · ') : '未发现明显问题'}{result.quality.issues.length > 3 ? ` · 另有 ${result.quality.issues.length - 3} 项` : ''}</span>}</span>
            </button><span className="workflow-asset-actions"><button type="button" aria-label={`上移 ${photo.fileName}`} disabled={index === 0} onClick={() => onMoveAsset(photo.id, -1)}><ArrowUp size={13} /></button><button type="button" aria-label={`下移 ${photo.fileName}`} disabled={index === workflowPhotos.length - 1} onClick={() => onMoveAsset(photo.id, 1)}><ArrowDown size={13} /></button><button type="button" aria-label={`移除 ${photo.fileName}`} onClick={() => onRemoveAsset(photo.id)}><X size={13} /></button></span></div>;
            })}</div> */
          })}</div>}
        {batchContextMenu && <div className="batch-context-menu" role="menu" style={{ left: Math.min(batchContextMenu.x, window.innerWidth - 220), top: Math.min(batchContextMenu.y, window.innerHeight - 180) }} onPointerDown={(event) => event.stopPropagation()}><button type="button" onClick={() => { setNotice(`已准备重试 ${workflowPhotos.find((item) => item.id === batchContextMenu.assetId)?.fileName ?? '当前图片'}。`); setBatchContextMenu(null); }}><RotateCcw size={13} />单独重试</button><button type="button" onClick={() => { void window.desktopApi.revealCatalogAsset(batchContextMenu.assetId); setBatchContextMenu(null); }}><FolderOpen size={13} />打开原图位置</button>{batchContextMenu.resultId && <button type="button" onClick={() => { void window.desktopApi.revealGenerationResult(batchContextMenu.resultId!); setBatchContextMenu(null); }}><FolderOpen size={13} />打开生成图位置</button>}<button type="button" onClick={() => setBatchContextMenu(null)}>取消</button></div>}
        {stage === 'analysis' && currentRevision && <section className="workflow-analysis-detail"><h3>{currentPhoto?.fileName}</h3><p>{currentRevision.result.report}</p><button className="quiet-button compact" type="button" onClick={() => setStage('optimization')}>查看优化建议 <ChevronRight size={13} /></button></section>}
        {stage === 'collection' && <div className="workflow-info-card"><h3>相册整体分析</h3>{collectionReport ? <><p>{collectionReport.summary}</p><div className="workflow-summary-grid"><article><strong>{collectionReport.groups.length}</strong><span>相似候选组</span></article><article><strong>{collectionReport.keep.length}</strong><span>推荐保留</span></article><article><strong>{collectionReport.review.length}</strong><span>建议审阅</span></article></div>{collectionReport.groups.map((group, index) => <p className="workflow-report-row" key={index}><strong>相似组 {index + 1}</strong>{group.join('、')}</p>)}{collectionReport.recommendations.map((item, index) => <p className="workflow-report-row" key={`recommendation-${index}`}>{item}</p>)}</> : <span className="workflow-muted">尚无分析结果</span>}</div>}
        {(stage === 'optimization' || stage === 'prompt') && (currentRevision ? <div className="workflow-info-card"><h3>{currentPhoto?.fileName}</h3><p>{currentRevision.result.summary}</p><div className="workflow-rule-list">{(itemRules[effectiveCurrentId!] ?? []).map((rule) => <label className="workflow-rule" key={rule.id}><input type="checkbox" checked={rule.enabled} onChange={() => setItemRules((current) => ({ ...current, [effectiveCurrentId!]: (current[effectiveCurrentId!] ?? []).map((item) => item.id === rule.id ? { ...item, enabled: !item.enabled } : item) }))} /><input value={rule.text} onChange={(event) => setItemRules((current) => ({ ...current, [effectiveCurrentId!]: (current[effectiveCurrentId!] ?? []).map((item) => item.id === rule.id ? { ...item, text: event.target.value } : item) }))} /></label>)}</div></div> : workflowPhotos.length > 0 && <p className="workflow-muted workflow-inline-empty">选择已识别照片以查看优化建议</p>)}
        {stage === 'prompt' && <div className="workflow-info-card"><h3>当前照片模板</h3>{effectiveCurrentId && <label className="workflow-field"><span>专用模板</span><select value={itemTemplateIds[effectiveCurrentId] ?? ''} onChange={(event) => setItemTemplateIds((current) => ({ ...current, [effectiveCurrentId]: event.target.value }))}><option value="">继承批次默认模板</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>}<pre className="workflow-prompt-preview">{[...globalRules.filter((item) => item.enabled).map((item) => item.text), ...(effectiveCurrentId ? (itemRules[effectiveCurrentId] ?? []).filter((item) => item.enabled).map((item) => item.text) : [])].join('\n')}</pre></div>}
        {stage === 'generation' && <div className="workflow-info-card"><h3>生成数量</h3><label className="workflow-number-field"><span>批次默认</span><input aria-label="批次默认生成数量" type="number" min="1" max="8" value={generationCount} onChange={(event) => setGenerationCount(clamp(Number(event.target.value) || 1, 1, 8))} /></label>{effectiveCurrentId && <label className="workflow-number-field"><span>当前图片</span><input aria-label="当前图片生成数量" type="number" min="1" max="8" value={itemGenerationCounts[effectiveCurrentId] ?? generationCount} onChange={(event) => setItemGenerationCounts((current) => ({ ...current, [effectiveCurrentId]: clamp(Number(event.target.value) || 1, 1, 8) }))} /></label>}<div className="workflow-generation-summary">{ids.reduce((sum, assetId) => sum + (itemGenerationCounts[assetId] ?? generationCount), 0)} 个任务</div></div>}
        {stage === 'review' && <div className="workflow-info-card"><h3>结果审阅</h3><button className="secondary-action compact" type="button" onClick={onOpenTasks}><Clock3 size={13} />查看任务状态</button></div>}
        {notice && <p className="workflow-notice" role="status">{notice}</p>}
      </section>
    </div>
  </main>;
}

function SettingsPage({ onExportPresetsChange }: { onExportPresetsChange: (presets: ExportPreset[]) => void }): React.JSX.Element {
  type SettingsSection = 'appearance' | 'models' | 'export' | 'storage' | 'tasks' | 'shortcuts' | 'privacy' | 'diagnostics';
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('models');
  const settingsContentRef = useRef<HTMLElement>(null);
  const providerNameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { settingsContentRef.current?.scrollTo({ top: 0 }); }, [settingsSection]);
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
  const [locale, setLocalePreference] = useState<AppSettings['locale']>('zh-CN');
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
      setLocalePreference(settings.locale);
      setCacheMaxBytes(settings.cacheMaxBytes);
    });
  }, [onExportPresetsChange]);

  const saveStorageMode = async (value: AppSettings['generationStorageMode']) => {
    setGenerationStorageMode(value);
    setStorageBusy(true);
    setStorageMessage('');
    try {
      const saved = await window.desktopApi.saveAppSettings({ generationStorageMode: value, theme, locale, cacheMaxBytes });
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
      const saved = await window.desktopApi.saveAppSettings({ generationStorageMode, theme: value, locale, cacheMaxBytes });
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
      const saved = await window.desktopApi.saveAppSettings({ generationStorageMode, theme, locale, cacheMaxBytes: value });
      setCacheMaxBytes(saved.cacheMaxBytes);
      setCacheStats(await window.desktopApi.getImageCacheStats());
      setCacheMessage('缓存上限已保存，超出部分已按最近使用时间清理。');
    } catch {
      setCacheMessage('缓存上限保存失败，请检查应用权限。');
    } finally {
      setCacheBusy(false);
    }
  };

  const saveLocale = async (value: Locale) => {
    setLocalePreference(value);
    setLocale(value);
    try {
      const saved = await window.desktopApi.saveAppSettings({ generationStorageMode, theme, locale: value, cacheMaxBytes });
      setLocalePreference(saved.locale);
    } catch {
      setMessage('语言设置保存失败，请检查应用权限。');
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
      setProfiles(await window.desktopApi.listProviderProfiles());
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
      await window.desktopApi.saveProviderProfile({ ...form, customHeaders });
      setProfiles(await window.desktopApi.listProviderProfiles());
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
        <button className={settingsSection === 'appearance' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('appearance')} aria-current={settingsSection === 'appearance' ? 'page' : undefined}><SunMoon size={14} />外观</button>
        <button className={settingsSection === 'models' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('models')} aria-current={settingsSection === 'models' ? 'page' : undefined}><Bot size={14} />AI 模型</button>
        <button className={settingsSection === 'export' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('export')} aria-current={settingsSection === 'export' ? 'page' : undefined}><Download size={14} />图片导出</button>
        <button className={settingsSection === 'storage' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('storage')} aria-current={settingsSection === 'storage' ? 'page' : undefined}><Folder size={14} />图库与存储</button>
        <button className={settingsSection === 'tasks' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('tasks')} aria-current={settingsSection === 'tasks' ? 'page' : undefined}><Clock3 size={14} />任务与重试</button>
        <button className={settingsSection === 'shortcuts' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('shortcuts')} aria-current={settingsSection === 'shortcuts' ? 'page' : undefined}><Command size={14} />快捷键</button>
        <button className={settingsSection === 'privacy' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('privacy')} aria-current={settingsSection === 'privacy' ? 'page' : undefined}><ShieldCheck size={14} />隐私与安全</button>
        <button className={settingsSection === 'diagnostics' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('diagnostics')} aria-current={settingsSection === 'diagnostics' ? 'page' : undefined}><ShieldCheck size={14} />诊断与维护</button>
      </aside>
      <main className="settings-content" ref={settingsContentRef}>
        {settingsSection === 'appearance' && <>
          <section className="settings-section storage-section"><div className="settings-heading"><div><h2>界面主题</h2><p>跟随系统会在系统外观变化时即时切换，不需要重启应用。</p></div><span><SunMoon size={14} />照片优先</span></div><div className="storage-options" aria-label="界面主题">{([['system', '跟随系统', '自动使用 macOS 或 Windows 当前外观。'], ['dark', '深色', '适合暗光环境和长时间看图。'], ['light', '浅色', '适合明亮环境和文档型工作流。']] as const).map(([value, label, description]) => <label className={theme === value ? 'is-selected' : ''} key={value}><input type="radio" name="theme" checked={theme === value} onChange={() => void saveTheme(value)} /><span><strong>{label}</strong><small>{description}</small></span><Check size={15} /></label>)}</div></section>
          <section className="settings-section storage-section"><div className="settings-heading"><div><h2>界面语言</h2><p>菜单和已适配的界面文字会即时切换，语言包设计支持后续扩展。</p></div><span><Command size={14} />i18n</span></div><div className="storage-options" aria-label="界面语言">{([['zh-CN', '简体中文', '中文界面和菜单。'], ['en-US', 'English', 'English interface and menus.']] as const).map(([value, label, description]) => <label className={locale === value ? 'is-selected' : ''} key={value}><input type="radio" name="locale" checked={locale === value} onChange={() => void saveLocale(value)} /><span><strong>{label}</strong><small>{description}</small></span><Check size={15} /></label>)}</div></section>
        </>}
        {settingsSection === 'models' && <>
        <section className="provider-layout">
          <div className="provider-list">
            <div className="provider-list-head"><div><strong>已配置服务</strong><span>{profiles.length}</span></div><button className="primary-action compact" type="button" disabled={busy !== null} onClick={() => { setForm({ ...emptyProviderForm }); setCustomHeadersText('{}'); setProviderDeleteCandidate(null); setMessage(''); providerNameRef.current?.focus(); }}><Plus size={14} />添加服务</button></div>
            {profiles.length === 0 ? (
              <div className="provider-empty"><Server size={25} /><strong>尚未配置模型</strong></div>
            ) : profiles.map((profile) => (
              <button className={`provider-item${form.id === profile.id ? ' is-selected' : ''}`} aria-pressed={form.id === profile.id} disabled={busy !== null} key={profile.id} type="button" onClick={() => { setMessage(''); setForm({
                id: profile.id,
                name: profile.name,
                kind: profile.kind,
                purpose: profile.purpose,
                baseUrl: profile.baseUrl,
                modelId: profile.modelId,
                requestTimeoutMs: profile.requestTimeoutMs,
                retryCount: profile.retryCount,
                customHeaders: profile.customHeaders,
                enabled: profile.enabled,
                isDefault: profile.isDefault
              }); setCustomHeadersText(JSON.stringify(profile.customHeaders, null, 2)); setProviderDeleteCandidate(null); }}>
                <span className="provider-icon">{profile.purpose === 'vision' ? <Bot size={16} /> : <WandSparkles size={16} />}</span>
                <span><strong>{profile.name}{profile.isDefault ? ' · 默认' : ''}</strong><small>{profile.purpose === 'vision' ? '视觉分析' : '图片生成'} · {profile.modelId}</small></span>
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
            <label><span>配置名称</span><input ref={providerNameRef} required maxLength={80} placeholder="例如：视觉分析 · 主服务" value={form.name} onChange={(event) => patchForm('name', event.target.value)} /></label>
            <label><span>Base URL</span><input required type="url" placeholder="https://api.example.com/v1" value={form.baseUrl} onChange={(event) => patchForm('baseUrl', event.target.value)} /><small>远程地址必须使用 HTTPS；本地开发服务可使用 localhost HTTP。</small></label>
            <label><span>Model ID</span><input required placeholder="模型标识" value={form.modelId} onChange={(event) => patchForm('modelId', event.target.value)} /></label>
            <div className="form-grid two-columns">
              <label><span>请求超时</span><select aria-label="模型请求超时" value={form.requestTimeoutMs} onChange={(event) => patchForm('requestTimeoutMs', Number(event.target.value))}><option value={30_000}>30 秒</option><option value={60_000}>60 秒</option><option value={120_000}>2 分钟</option><option value={300_000}>5 分钟</option><option value={600_000}>10 分钟</option></select></label>
              <label><span>自动重试</span><select aria-label="模型自动重试次数" value={form.retryCount} onChange={(event) => patchForm('retryCount', Number(event.target.value))}><option value={0}>不重试</option><option value={1}>1 次</option><option value={2}>2 次</option><option value={3}>3 次</option><option value={5}>5 次</option></select><small>仅针对限流、网关和服务暂不可用；取消任务会中断等待。</small></label>
            </div>
            <label><span>自定义请求头</span><textarea aria-label="模型自定义请求头" rows={4} spellCheck={false} value={customHeadersText} onChange={(event) => { setCustomHeadersText(event.target.value); setMessage(''); }} /><small>使用 JSON 对象；认证、Cookie、Host、来源及传输层请求头不可覆盖。敏感凭据请只填写 API Key。</small></label>
            <label><span>API Key</span><div className="secret-input"><KeyRound size={14} /><input type="password" autoComplete="off" placeholder={form.id ? '留空以保留已保存凭据' : '输入服务密钥'} value={form.apiKey ?? ''} onChange={(event) => patchForm('apiKey', event.target.value)} /></div><small>密钥不会写入图库数据库、日志或导出清单。</small></label>
            <label className="enabled-row"><input type="checkbox" checked={form.enabled} onChange={(event) => patchForm('enabled', event.target.checked)} /><span>启用此配置</span></label>
            <label className="enabled-row"><input type="checkbox" disabled={!form.enabled} checked={form.enabled && Boolean(form.isDefault)} onChange={(event) => patchForm('isDefault', event.target.checked)} /><span>设为{form.purpose === 'vision' ? '视觉分析' : '图片生成'}默认配置</span></label>
            <div className="form-feedback" role="status">{message}</div>
            <div className="form-actions">{form.id && <button className="danger-action compact" type="button" disabled={busy !== null} onClick={() => void deleteProvider()}>{providerDeleteCandidate === form.id ? '确认删除' : '删除配置'}</button>}<button className="secondary-action" type="button" disabled={busy !== null} onClick={() => void testConnection()}>{busy === 'test' ? '测试中…' : '测试连接'}</button><button className="primary-action compact" type="submit" disabled={busy !== null}>{busy === 'save' ? '保存中…' : '保存配置'}</button></div>
          </form>
        </section>
        </>}
        {settingsSection === 'export' && <section className="settings-section export-presets-section">
          <div className="settings-heading"><div><h2>导出预设</h2><p>保存格式、尺寸、JPEG 质量和命名策略；原格式导出不会重新编码。</p></div><span><Download size={14} />受管结果可随时导出</span></div>
          <div className="preset-row"><input aria-label="导出预设名称" placeholder="例如：客户交付" value={presetName} onChange={(event) => { setPresetName(event.target.value); setPresetMessage(''); }} /><select aria-label="导出格式" value={presetFormat} onChange={(event) => setPresetFormat(event.target.value as ExportPreset['format'])}><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="original">原格式</option></select><input aria-label="JPEG 质量" type="number" min="1" max="100" disabled={presetFormat !== 'jpeg'} value={presetQuality} onChange={(event) => setPresetQuality(Number(event.target.value))} /><select aria-label="导出尺寸" value={presetMaxDimension ?? ''} onChange={(event) => setPresetMaxDimension(event.target.value ? Number(event.target.value) : null)}><option value="">原始尺寸</option><option value="2048">长边 2048px</option><option value="3840">长边 3840px</option><option value="6000">长边 6000px</option></select><button className="primary-action compact" type="button" disabled={!presetName.trim()} onClick={async () => { try { const saved = await window.desktopApi.saveExportPreset({ name: presetName.trim(), format: presetFormat, quality: presetQuality, maxDimension: presetMaxDimension, conflictPolicy: 'auto-rename', namingPattern: '{name}_{version}' }); setPresets((current) => { const next = [...current.filter((item) => item.id !== saved.id), saved]; onExportPresetsChange(next); return next; }); setPresetName(''); setPresetMessage('预设已保存'); } catch { setPresetMessage('名称已存在或保存失败'); } }}>保存预设</button></div>
          <div className="preset-list">{presets.length === 0 ? <small>暂无导出预设</small> : presets.map((preset) => <div className="preset-item" key={preset.id}><span><strong>{preset.name}</strong><small>{preset.format === 'original' ? '原格式' : preset.format.toUpperCase()}{preset.format === 'jpeg' ? ` · 质量 ${preset.quality}` : ''}{preset.maxDimension ? ` · 长边 ${preset.maxDimension}px` : ''} · {preset.conflictPolicy === 'skip' ? '跳过同名' : '自动编号'}</small></span><button type="button" aria-label={`删除导出预设 ${preset.name}`} onClick={async () => { await window.desktopApi.deleteExportPreset(preset.id); setPresets((current) => { const next = current.filter((item) => item.id !== preset.id); onExportPresetsChange(next); return next; }); }}>删除</button></div>)}</div>
          {presetMessage && <div className="form-feedback" role="status">{presetMessage}</div>}
        </section>}
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
        {settingsSection === 'diagnostics' && <section className="settings-section diagnostics-section">
          <div className="settings-heading"><div><h2>诊断摘要</h2><p>仅包含运行统计，不包含路径、密钥、图片内容或模型响应。</p></div><span><ShieldCheck size={14} />可安全提交给支持团队</span></div>
          {diagnostics && <div className="diagnostic-health-strip"><span>自动备份：{diagnostics.startupRecovery.automaticBackup.status === 'completed' ? '已完成' : diagnostics.startupRecovery.automaticBackup.status === 'skipped' ? '已跳过' : diagnostics.startupRecovery.automaticBackup.status === 'failed' ? '失败' : '进行中'}</span><span>目录监听：{diagnostics.catalogWatcher.activeWatchers}/{diagnostics.catalogWatcher.watchedFolders}</span><span>监听失败：{diagnostics.catalogWatcher.watchFailures}</span><span>协调失败：{diagnostics.catalogWatcher.reconciliationFailures}</span></div>}
          {diagnostics && <div className="cache-actions"><button className="secondary-action compact" type="button" disabled={integrityBusy} onClick={() => void runIntegrityCheck()}><ShieldCheck size={13} />{integrityBusy ? '检查中…' : '重新检查图库'}</button><button className="secondary-action compact" type="button" onClick={() => void copyDiagnostics()}><Copy size={13} />复制脱敏摘要</button><button className="secondary-action compact" type="button" disabled={diagnosticBusy} onClick={() => void exportDiagnostics()}><Download size={13} />{diagnosticBusy ? '导出中…' : '导出诊断文件'}</button><span role="status">{diagnosticMessage}</span></div>}
          {diagnostics ? <div className="diagnostic-grid"><span>版本<strong>{diagnostics.appVersion}</strong></span><span>图库<strong>{diagnostics.catalog.assets} 张 · 离线 {diagnostics.catalog.offline}</strong></span><span className={`integrity-result is-${diagnostics.integrity.status}`}>完整性<strong>{diagnostics.integrity.status === 'healthy' ? '正常' : diagnostics.integrity.status === 'warning' ? '需关注' : '发现错误'}</strong><small>数据库 {diagnostics.integrity.databaseStatus === 'ok' ? '正常' : diagnostics.integrity.databaseStatus === 'corrupt' ? '损坏' : '无法读取'} · 活动缺失 {diagnostics.integrity.missingActiveFiles} · 孤立 {diagnostics.integrity.unexpectedGeneratedFiles + diagnostics.integrity.unexpectedTrashFiles} · 待恢复 {diagnostics.integrity.pendingGenerationWrites}（异常 {diagnostics.integrity.unsafeGenerationWriteIntents}）</small></span><span>启动恢复<strong>{diagnostics.startupRecovery.trashPurges.recovered + diagnostics.startupRecovery.fileOperations.resolved + diagnostics.startupRecovery.generationWrites.recovered} 项</strong><small>冲突 {diagnostics.startupRecovery.trashPurges.conflicts} · 失败 {diagnostics.startupRecovery.trashPurges.failed + diagnostics.startupRecovery.fileOperations.failed + diagnostics.startupRecovery.generationWrites.failed}</small></span><span>模型<strong>{diagnostics.providers.enabled}/{diagnostics.providers.total} 已启用</strong></span><span>缓存<strong>{(diagnostics.cache.bytes / 1_073_741_824).toFixed(2)} GiB</strong><small>命中 {diagnostics.cache.performance.hits} · 未命中 {diagnostics.cache.performance.misses}</small></span><span>解码<strong>{diagnostics.cache.performance.decodes} 次</strong><small>累计 {Math.round(diagnostics.cache.performance.decodeMsTotal)} ms</small></span><span>RAW 代理<strong>{diagnostics.cache.raw.imageMagick ? 'ImageMagick' : diagnostics.cache.raw.sips ? 'sips' : '未安装'}</strong><small>原生入口已启用；完整显影仍按发布计划推进</small></span></div> : <small>正在读取诊断摘要…</small>}
        </section>}
      </main>
      {trashConfirmationOpen && trashSummary && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !trashBusy) setTrashConfirmationOpen(false); }}><section className="removal-dialog is-destructive" role="alertdialog" aria-modal="true" aria-labelledby="empty-trash-title" aria-describedby="empty-trash-description"><header><span className="dialog-icon"><Trash2 size={17} /></span><div><h2 id="empty-trash-title">永久清理 {trashSummary.resultCount} 个生成版本？</h2><p id="empty-trash-description">将释放约 {formatStorageBytes(trashSummary.totalBytes)}。这些版本及生成上下文会从当前图库永久移除，操作无法撤销。</p></div></header><div className="removal-impact"><CircleAlert size={15} /><span>只清理应用内部生成版本回收站。原图、活动生成版本、便携目录中的活动文件和已导出副本不会被删除。</span></div><footer><button autoFocus className="quiet-button" type="button" disabled={trashBusy} onClick={() => setTrashConfirmationOpen(false)}>取消</button><button className="danger-action" type="button" disabled={trashBusy} onClick={() => void emptyGenerationTrash()}>{trashBusy ? '正在清理…' : '永久清理'}</button></footer></section></div>}
    </div>
  );
}

const taskLabels: Record<PersistedTask['kind'], string> = {
  agent: 'Agent 批处理',
  analysis: '视觉分析',
  'collection-analysis': '相册分析',
  generation: '图片生成',
  export: '导出'
};

const statusLabels: Record<PersistedTask['status'], string> = {
  draft: '草稿', queued: '等待中', preparing: '准备输入', uploading: '上传中',
  processing: '处理中', downloading: '下载中', saving: '保存中', completed: '已完成',
  paused: '已暂停', failed: '失败', canceled: '已取消'
};

function AnalysisFailure({ code, taskId, className = '' }: { code: string | null; taskId?: string; className?: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const message = analysisFailureMessage(code);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`视觉分析失败\n原因：${message}\n错误码：${code ?? 'ANALYSIS_FAILED'}${taskId ? `\n任务 ID：${taskId}` : ''}`);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };
  useEffect(() => { setCopyState('idle'); }, [code, taskId]);
  return <span className={`analysis-failure ${className}`} role="alert"><span>{message} <code>{code ?? 'ANALYSIS_FAILED'}</code>{copyState === 'failed' && <small>复制失败，请检查剪贴板权限</small>}</span><button className="analysis-copy-error" type="button" aria-label="复制错误信息" title={copyState === 'copied' ? '已复制错误信息' : '复制错误信息'} onClick={(event) => { event.stopPropagation(); void copy(); }}>{copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}</button></span>;
}

function taskScope(task: PersistedTask): string {
  if (task.kind === 'analysis') return '单图分析';
  if (task.kind === 'generation') return `单图 · 候选 ${typeof task.payload.resultIndex === 'number' ? task.payload.resultIndex : 1}`;
  if (task.kind === 'collection-analysis') return `${Array.isArray(task.payload.assetIds) ? task.payload.assetIds.length : '多'} 张图片 · 联合分析`;
  if (task.kind === 'export') return `${Array.isArray(task.payload.resultIds) ? task.payload.resultIds.length : '多'} 个版本 · 批量导出`;
  return 'Agent 会话';
}

function taskImageName(task: PersistedTask, photos: Photo[]): string {
  return task.assetFileName ?? photos.find((photo) => photo.id === task.assetId)?.fileName ?? (task.assetId ? `图片 ${task.assetId.slice(0, 8)}` : taskLabels[task.kind]);
}

function taskStage(task: PersistedTask): string {
  if (task.status === 'processing') return task.kind === 'analysis' || task.kind === 'collection-analysis' ? '模型分析中' : task.kind === 'generation' ? '模型生成中' : '执行中';
  return statusLabels[task.status];
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

function TaskCenterPage({ onCatalogChanged, onOpenViewer: openViewer, photos: providedPhotos }: { onCatalogChanged: () => Promise<void>; onOpenViewer: (assetId: string, assetIds?: string[]) => void; photos: Photo[] }): React.JSX.Element {
  const [taskItems, setTaskItems] = useState<PersistedTask[]>([]);
  const photos = useTaskPhotos(taskItems, providedPhotos);
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
  const [taskView, setTaskView] = useState<'all' | 'queued' | 'active' | 'paused' | 'failed' | 'history'>('all');

  const applyTaskPage = (page: Awaited<ReturnType<typeof window.desktopApi.listTaskPage>>, append = false) => {
    setTaskItems((current) => append
      ? [...new Map([...current, ...page.items].map((item) => [item.id, item])).values()]
      : page.items);
    if (!append) setNextTaskCursor(page.nextCursor);
    setTaskTotalCount(page.totalCount);
    setTaskCounts({
      queued: page.queuedCount,
      paused: page.pausedCount,
      active: page.activeCount,
      failed: page.failedCount,
      failedGeneration: page.failedGenerationCount
    });
  };
  const fetchPage = async (): Promise<TaskPage> => {
    return window.desktopApi.listTaskPage({ includeBatchMembers: true, limit: 50, cursor: null });
  };
  const refresh = async () => {
    const page = await fetchPage();
    loadedTaskHistory.current = false;
    applyTaskPage(page);
  };
  useEffect(() => {
    let active = true;
    const poll = async () => {
      const [page, operations] = await Promise.all([
        fetchPage(),
        window.desktopApi.listFileOperationHistory()
      ]);
      if (active) {
        applyTaskPage(page, loadedTaskHistory.current);
        setFileOperations(operations);
      }
    };
    const safePoll = () => poll().catch(() => { if (active) setMessage('任务加载失败，请稍后重试。'); });
    void safePoll();
    const changed = (event: Event) => {
      const deleted = new Set((event as CustomEvent<{ deletedIds?: string[] }>).detail?.deletedIds ?? []);
      if (deleted.size) setTaskItems((current) => current.filter((task) => !deleted.has(task.id)));
      void safePoll();
    };
    window.addEventListener(TASKS_CHANGED_EVENT, changed);
    const interval = window.setInterval(safePoll, 1_000);
    return () => { active = false; window.clearInterval(interval); window.removeEventListener(TASKS_CHANGED_EVENT, changed); };
  }, []);
  useEffect(() => {
    void Promise.all([window.desktopApi.listProviderProfiles(), window.desktopApi.listPromptTemplates()]).then(([profiles, items]) => {
      setGenerationProfiles(profiles.filter((profile) => profile.purpose === 'generation' && profile.enabled));
      setTemplates(items);
    });
  }, []);

  const retryFailedGeneration = async () => {
    try {
      const count = await window.desktopApi.retryFailedTasks();
      setMessage(`已重新排队 ${count} 个任务。`);
      window.dispatchEvent(new CustomEvent(TASKS_CHANGED_EVENT));
      await refresh();
    } catch { setMessage('重试失败，请刷新任务后重试。'); }
  };
  const loadMoreTasks = async () => {
    if (!nextTaskCursor || loadingMoreTasks) return;
    setLoadingMoreTasks(true);
    loadedTaskHistory.current = true;
    try {
      const page = await window.desktopApi.listTaskPage({ includeBatchMembers: true, limit: 50, cursor: nextTaskCursor });
      applyTaskPage(page, true);
      setNextTaskCursor(page.nextCursor);
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
  const taskBatches = groupTaskBatches(taskItems);
  const onOpenViewer = (assetId: string, assetIds?: string[]) => openViewer(assetId, assetIds ?? taskBatches.find((batch) => batch.tasks.some((task) => task.assetId === assetId))?.tasks.flatMap((task) => task.assetId ? [task.assetId] : []));
  const filteredBatches = taskBatches.filter((batch) => taskView === 'all' || (taskView === 'active'
    ? batch.active > 0 : taskView === 'queued' ? batch.queued > 0 : taskView === 'paused' ? batch.paused > 0
    : taskView === 'failed' ? batch.failed > 0 : batch.settled === batch.total));

  return (
    <TaskActions tasks={taskBatches.flatMap((batch) => batch.tasks)} onOpenViewer={onOpenViewer} onEditTask={openPromptEditor}>
    <div className="task-center-page">
      <nav className="task-view-switch" aria-label="筛选任务">{([
        ['all', '全部', taskTotalCount], ['queued', '排队', waiting], ['active', '运行', taskCounts.active],
        ['paused', '暂停', taskCounts.paused], ['failed', '失败', failed],
        ['history', '已结束', taskTotalCount - waiting - taskCounts.active - taskCounts.paused]
      ] as const).map(([value, label, count]) => <button type="button" key={value} aria-label={label} aria-pressed={taskView === value} onClick={() => setTaskView(value)}>{label}<span className="task-tab-count">{count}</span></button>)}<div className="task-toolbar-actions"><button className="quiet-button" type="button" disabled={failed === 0} onClick={() => void retryFailedGeneration()}><RotateCcw size={13} />重试</button><TaskClearButton disabled={taskTotalCount === 0} /></div></nav>
      {message && <span className="task-feedback" role="status">{message}</span>}
      <div className="task-table">
        {filteredBatches.length === 0 ? (
          <div className="task-empty"><Clock3 size={30} /><h2>{taskItems.length ? '当前筛选下暂无任务' : '暂无任务'}</h2><p>{nextTaskCursor ? '可继续加载任务记录。' : '开始视觉分析、生成或导出后，在这里查看执行记录。'}</p></div>
        ) : filteredBatches.map((batch) => <TaskBatchGroup key={batch.id} tasks={batch.tasks} photos={photos} onOpenViewer={onOpenViewer}>{batch.tasks.map((task) => {
          const report = exportTaskReport(task);
          const reportOpen = expandedExportTaskId === task.id;
          return <Fragment key={task.id}>
          <div className="task-table-row" data-task-id={task.id}>
            <span className="task-kind"><button className="task-member-preview task-table-preview" type="button" disabled={!photos.find((photo) => photo.id === task.assetId)} onClick={() => { if (task.assetId) onOpenViewer(task.assetId, batch.tasks.flatMap((item) => item.assetId ? [item.assetId] : [])); }} aria-label={`预览 ${taskImageName(task, photos)}`}>{(photos.find((photo) => photo.id === task.assetId)?.thumbnailSrc || photos.find((photo) => photo.id === task.assetId)?.src) ? <img className="task-item-thumbnail" src={photos.find((photo) => photo.id === task.assetId)!.thumbnailSrc || photos.find((photo) => photo.id === task.assetId)!.src} alt={taskImageName(task, photos)} /> : <TaskKindIcon kind={task.kind} />}</button><span><strong title={taskImageName(task, photos)}>{taskImageName(task, photos)}</strong><small>{taskLabels[task.kind]}</small></span></span>
            <span className="task-scope">{taskScope(task)}</span>
            <span className={`task-state state-${task.status}`}>{taskStage(task)}</span>
            <span>{task.attempt + 1}</span>
            <span>{new Date(task.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <span className="task-row-actions">
              {report && <IconButton label={reportOpen ? '收起导出报告' : '查看导出报告'} active={reportOpen} pressed={reportOpen} onClick={() => setExpandedExportTaskId(reportOpen ? null : task.id)}>{reportOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</IconButton>}
            </span>
          </div>
          {task.status === 'failed' && (task.kind === 'analysis' || task.kind === 'collection-analysis') && <AnalysisFailure code={task.errorCode} taskId={task.id} className="task-analysis-failure" />}
          <TaskAnalysisResult task={task} />
          <TaskOutput task={task} photos={photos} />
          {task.status === 'failed' && task.kind !== 'analysis' && task.kind !== 'collection-analysis' && <div className="task-analysis-failure" role="alert">{task.kind === 'export' ? exportFailureMessage(task.errorCode ?? '') : '任务执行失败'} <code>{task.errorCode}</code></div>}
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
        })}</TaskBatchGroup>)}
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
    </TaskActions>
  );
}

function TaskKindIcon({ kind }: { kind: PersistedTask['kind'] }): React.JSX.Element {
  if (kind === 'analysis') return <Bot size={15} />;
  if (kind === 'collection-analysis') return <Layers3 size={15} />;
  if (kind === 'generation') return <WandSparkles size={15} />;
  if (kind === 'agent') return <Bot size={15} />;
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
      <div className="template-workspace">
        <section className="template-browser">
          <div className="template-browser-tools"><div className="inline-search"><Search size={14} /><input aria-label="搜索模板" value={templateSearch} placeholder="搜索模板" onChange={(event) => setTemplateSearch(event.target.value)} /></div><label className="template-category-filter"><ListFilter size={14} /><select aria-label="模板分类" value={templateCategory} onChange={(event) => setTemplateCategory(event.target.value)}><option>全部分类</option><option>人像</option><option>风光</option><option>商品</option><option>建筑</option><option>其他</option></select></label><button className="primary-action compact" type="button" onClick={() => { setForm(emptyTemplateForm); setMessage(''); }}><Plus size={15} />新建模板</button></div>
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

function InlinePhotoViewer({ workspace, photo, items, onPhotoChange, onClose, resultId }: { workspace: LibraryWorkspaceProps; photo: Photo; items: Photo[]; onPhotoChange: (photo: Photo) => void; onClose: () => void; resultId: string | null }): React.JSX.Element {
  const panelRef = useRef<HTMLElement>(null);
  const [selection, setSelection] = useState<SelectionState>(() => ({ selectedIds: new Set([photo.id]), anchorId: photo.id, focusId: photo.id }));
  useEffect(() => { panelRef.current?.querySelector<HTMLElement>('.canvas-wrap')?.focus({ preventScroll: true }); }, []);
  return <section className="inline-photo-viewer" aria-label="看图" ref={panelRef} onKeyDown={(event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || panelRef.current?.querySelector('[role="dialog"], [role="menu"], .tag-editor-popover')) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }}><LibraryWorkspace {...workspace} active view="viewer" availablePhotos={items} selectedAssetId={photo.id} selection={selection} onSelectionChange={setSelection} onSelectedAssetChange={(id) => { const next = items.find((item) => item.id === id); if (next) onPhotoChange(next); }} totalCount={items.length} hasMore={false} onCloseViewer={onClose} initialResultId={resultId} /></section>;
}

export function App(): React.JSX.Element {
  const [globalLayout, setGlobalLayout] = useViewerLayout();
  const [panelVisibility, setPanelVisibility] = useState(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem('photoallisai.panel-visibility.v1') ?? '{}');
      return { left: saved.left !== false, right: saved.right !== false };
    } catch { return { left: true, right: true }; }
  });
  const panelsBeforeHide = useRef<{ left: boolean; right: boolean } | null>(null);
  useEffect(() => {
    try { window.localStorage.setItem('photoallisai.panel-visibility.v1', JSON.stringify(panelVisibility)); } catch { /* Keep the in-memory layout. */ }
  }, [panelVisibility]);
  useEffect(() => {
    const togglePanels = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.repeat || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      event.preventDefault();
      setPanelVisibility((current) => {
        if (current.left || current.right) {
          panelsBeforeHide.current = current;
          return { left: false, right: false };
        }
        const restored = panelsBeforeHide.current ?? { left: true, right: true };
        panelsBeforeHide.current = null;
        return restored;
      });
      if (target instanceof HTMLElement && target.closest('.workspace-side-panel')) target.blur();
    };
    window.addEventListener('keydown', togglePanels);
    return () => window.removeEventListener('keydown', togglePanels);
  }, []);
  const [navigationNotice, setNavigationNotice] = useState('');
  const [globalTasks, setGlobalTasks] = useState<PersistedTask[]>([]);
  const [globalTaskCounts, setGlobalTaskCounts] = useState<Pick<TaskPage, 'activeCount' | 'queuedCount' | 'failedCount' | 'pausedCount'>>({ activeCount: 0, queuedCount: 0, failedCount: 0, pausedCount: 0 });
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [dockLayout, setDockLayout] = useState(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem('photoallisai.dock-layout.v1') ?? '') as { agentOpen?: boolean; collapsed?: boolean; order?: string[]; split?: number };
      return { agentOpen: saved.agentOpen ?? false, collapsed: saved.collapsed ?? false, order: saved.order?.filter((item) => item === 'agent' || item === 'details') ?? ['agent', 'details'], split: clamp(saved.split ?? 44, 28, 68) };
    } catch { return { agentOpen: false, collapsed: false, order: ['agent', 'details'], split: 44 }; }
  });
  const [dockTab, setDockTab] = useInspectorTab();
  const agentDockOpen = dockLayout.agentOpen && !dockLayout.collapsed;
  const saveDockLayout = (next: typeof dockLayout) => {
    setDockLayout(next);
    try { window.localStorage.setItem('photoallisai.dock-layout.v1', JSON.stringify(next)); } catch { /* in-memory layout remains available */ }
  };
  const setAgentDockOpen = (open: boolean) => saveDockLayout({ ...dockLayout, agentOpen: open, collapsed: false });
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
  const [viewerPhoto, setViewerPhoto] = useState<Photo | null>(null);
  const [viewerPhotos, setViewerPhotos] = useState<Photo[]>([]);
  const [viewerResultId, setViewerResultId] = useState<string | null>(null);
  const viewerRequest = useRef(0);
  const openViewerRef = useRef<(assetId: string, assetIds?: string[]) => void>(() => undefined);
  const viewerOrigin = useRef<{ focus: HTMLElement | null; drawerOpen: boolean } | null>(null);
  const closeViewer = useCallback(() => {
    viewerRequest.current += 1;
    setViewerPhoto(null);
    setViewerPhotos([]);
    setViewerResultId(null);
    setViewerPreloading(false);
    const origin = viewerOrigin.current;
    viewerOrigin.current = null;
    if (origin) {
      setTaskDrawerOpen(origin.drawerOpen);
      window.requestAnimationFrame(() => { if (origin.focus?.isConnected) origin.focus.focus({ preventScroll: true }); });
    }
  }, []);
  const [sharedSelection, setSharedSelection] = useState<SelectionState>({ selectedIds: new Set(), anchorId: null, focusId: null });
  const [workflowAssetIds, setWorkflowAssetIds] = useState<string[]>(() => loadWorkflowDraft().workflowAssetIds);
  const [workflowAssetMeta, setWorkflowAssetMeta] = useState<Record<string, WorkflowAssetMeta>>(() => loadWorkflowDraft().workflowAssetMeta);
  const [workflowRules, setWorkflowRules] = useState<WorkflowRule[]>(() => loadWorkflowDraft().globalRules);
  const [workflowTemplateId, setWorkflowTemplateId] = useState(() => loadWorkflowDraft().templateId);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const draft = loadWorkflowDraft();
        window.localStorage.setItem(WORKFLOW_DRAFT_KEY, JSON.stringify({ ...draft, workflowAssetIds, workflowAssetMeta, globalRules: workflowRules, templateId: workflowTemplateId } satisfies WorkflowDraft));
      } catch {
        // localStorage may be unavailable in restricted sessions; the in-memory queue remains usable.
      }
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [workflowAssetIds, workflowAssetMeta, workflowRules, workflowTemplateId]);
  const [viewerPreloading, setViewerPreloading] = useState(false);
  useEffect(() => { closeViewer(); }, [activeTab, closeViewer]);
  useEffect(() => {
    if (!viewerPreloading && !viewerPhoto) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[role="dialog"], [role="menu"], .tag-editor-popover')) return;
      event.preventDefault();
      closeViewer();
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [closeViewer, viewerPhoto, viewerPreloading]);
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
      setLocale(settings.locale);
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

  const importFolders = useCallback(async () => {
    const result = await window.desktopApi.importFolders();
    if (result) await refreshCatalog();
  }, [refreshCatalog]);

  const relinkFolder = async (folderId: string) => {
    const result = await window.desktopApi.relinkCatalogFolder(folderId);
    if (result) await refreshCatalog();
  };

  const synchronizeFolder = async (folderId: string) => {
    const report = await window.desktopApi.synchronizeCatalogFolder(folderId);
    await refreshCatalog();
    return report;
  };

  const revealFolder = (folderId: string) => window.desktopApi.revealCatalogFolder(folderId);

  const unregisterFolder = async (folderId: string) => {
    await window.desktopApi.unregisterCatalogFolder({ folderId });
    setSelectedFolderId(null);
    setSelectedAssetId(null);
    await refreshCatalog(null);
  };

  const moveFolder = async (sourceFolderId: string, targetFolderId: string) => {
    if (typeof window.desktopApi.moveCatalogFolder !== 'function') {
      throw new Error('DESKTOP_API_OUTDATED');
    }
    const result = await window.desktopApi.moveCatalogFolder({ sourceFolderId, targetFolderId });
    setSelectedFolderId(result.folder.id);
    setSelectedAlbumId(null);
    setSelectedSmartCollection(null);
    await refreshCatalog(result.folder.id);
    return result.folder;
  };

  const openWorkspaceTab = useCallback((tab: WorkspaceTab) => {
    if (tab === 'viewer') return;
    setOpenTabs((current) => current.includes(tab) ? current : [...current, tab]);
    setActiveTab(tab);
  }, []);

  const closeWorkspaceTab = useCallback((tab: WorkspaceTab) => {
    if (tab === 'library') return;
    setOpenTabs((current) => current.filter((item) => item !== tab));
    setActiveTab((current) => current === tab ? 'library' : current);
  }, []);

  useEffect(() => {
    const unsubscribe = window.desktopApi.onMenuCommand((command) => {
      if (command === 'open-library') openWorkspaceTab('library');
      else if (command === 'open-viewer') { if (selectedAssetId) openViewerRef.current(selectedAssetId); }
      else if (command === 'open-batch' || command === 'open-workflow') openWorkspaceTab('batch');
      else if (command === 'open-templates' || command === 'open-prompt-templates') openWorkspaceTab('templates');
      else if (command === 'open-tasks' || command === 'open-task-center') openWorkspaceTab('tasks');
      else if (command === 'open-settings') openWorkspaceTab('settings');
      else if (command === 'import-folders') void importFolders();
      else if (command === 'refresh-catalog') void refreshCatalog();
      else if (command === 'select-all') {
        const focused = document.activeElement;
        if (focused instanceof HTMLTextAreaElement || (focused instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'email', 'password'].includes(focused.type))) {
          focused.select();
        } else if (focused instanceof HTMLElement && focused.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(focused);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        } else if (focused instanceof Element && !focused.closest('input, textarea, select')) {
          const photoList = focused.closest('.filmstrip, .catalog-grid, .catalog-list-view');
          photoList?.dispatchEvent(new Event('photoallisai:select-all-photos', { bubbles: true }));
        }
      }
      else if (command === 'clear-selection') {
        const focused = document.activeElement;
        if (focused instanceof Element && !focused.closest('input, textarea, select, [contenteditable="true"]') && focused.closest('.filmstrip, .catalog-grid, .catalog-list-view')) setSharedSelection({ selectedIds: new Set(), anchorId: null, focusId: selectedAssetId });
      }
      else if (command === 'close-workspace') { if (viewerPhoto || viewerPreloading) closeViewer(); else closeWorkspaceTab(activeTab); }
      else window.dispatchEvent(new CustomEvent('photoallisai:menu-command', { detail: command }));
    });
    return unsubscribe;
  }, [activeTab, catalogPhotos, catalogReady, catalogTotal, closeViewer, closeWorkspaceTab, importFolders, openWorkspaceTab, refreshCatalog, selectedAssetId, viewerPhoto, viewerPreloading]);

  useEffect(() => {
    const handleWorkspaceShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === 'a') {
        const target = event.target;
        if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'email', 'password'].includes(target.type))) {
          event.preventDefault();
          target.select();
        }
        return;
      }
      if (event.key.toLowerCase() === 'w' && (viewerPhoto || viewerPreloading || activeTab !== 'library')) {
        event.preventDefault();
        if (viewerPhoto || viewerPreloading) closeViewer(); else closeWorkspaceTab(activeTab);
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
  }, [activeTab, closeViewer, closeWorkspaceTab, openTabs, viewerPhoto, viewerPreloading]);

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
  useEffect(() => {
    const open = () => setTaskDrawerOpen(true);
    window.addEventListener(OPEN_TASK_DRAWER_EVENT, open);
    return () => window.removeEventListener(OPEN_TASK_DRAWER_EVENT, open);
  }, []);
  useEffect(() => {
    if (isDemo) return;
    let active = true;
    const refresh = () => {
      void window.desktopApi.listTaskPage({ includeBatchMembers: true, limit: 20, cursor: null }).then((page) => {
        if (active) {
          setGlobalTasks(page.items);
          setGlobalTaskCounts({ activeCount: page.activeCount, queuedCount: page.queuedCount, failedCount: page.failedCount, pausedCount: page.pausedCount });
        }
      }).catch(() => undefined);
    };
    refresh();
    const interval = window.setInterval(refresh, 1_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [isDemo]);
  useEffect(() => {
    if (workflowAssetIds.length === 0) return;
    setWorkflowAssetMeta((current) => {
      let changed = false;
      const next = { ...current };
      for (const id of workflowAssetIds) {
        if (next[id]) continue;
        const photo = availablePhotos.find((item) => item.id === id);
        if (!photo) continue;
        next[id] = { id: photo.id, fileName: photo.fileName, src: photo.src, ...(photo.thumbnailSrc ? { thumbnailSrc: photo.thumbnailSrc } : {}), format: photo.format };
        changed = true;
      }
      return changed ? next : current;
    });
  }, [availablePhotos, workflowAssetIds]);
  const globalFocusPhoto = viewerPhoto ?? availablePhotos.find((photo) => photo.id === sharedSelection.focusId)
    ?? catalogPhotos.find((photo) => photo.id === sharedSelection.focusId)
    ?? availablePhotos.find((photo) => photo.id === selectedAssetId)
    ?? availablePhotos[0];
  const contextSelectedIds = useMemo(() => viewerPhoto ? new Set([viewerPhoto.id]) : sharedSelection.selectedIds, [viewerPhoto, sharedSelection.selectedIds]);
  const contextPhotos = useMemo(() => viewerPhoto ? [...viewerPhotos, ...availablePhotos.filter((photo) => !viewerPhotos.some((item) => item.id === photo.id))] : availablePhotos, [viewerPhoto, viewerPhotos, availablePhotos]);
  const addAssetsToWorkflow = useCallback((assetIds: string[]) => {
    const validIds = assetIds.filter((id) => contextPhotos.some((photo) => photo.id === id));
    if (validIds.length === 0) return;
    setWorkflowAssetIds((current) => {
      const next = [...current, ...validIds.filter((id) => !current.includes(id))];
      const added = next.length - current.length;
      window.dispatchEvent(new CustomEvent(OPERATION_NOTICE_EVENT, { detail: added > 0 ? `已加入 ${added} 张照片到 AI 批量修图${added < validIds.length ? `，${validIds.length - added} 张已在修图列表中` : ''}。` : '所选照片已在 AI 批量修图中。' }));
      return next;
    });
    setWorkflowAssetMeta((current) => {
      const next = { ...current };
      for (const id of validIds) {
        const photo = contextPhotos.find((item) => item.id === id);
        if (photo) next[id] = { id: photo.id, fileName: photo.fileName, src: photo.src, ...(photo.thumbnailSrc ? { thumbnailSrc: photo.thumbnailSrc } : {}), format: photo.format };
      }
      return next;
    });
  }, [contextPhotos]);
  const removeWorkflowAsset = useCallback((assetId: string) => {
    setWorkflowAssetIds((current) => current.filter((id) => id !== assetId));
    setWorkflowAssetMeta((current) => {
      const next = { ...current };
      delete next[assetId];
      return next;
    });
  }, []);
  const moveWorkflowAsset = useCallback((assetId: string, direction: -1 | 1) => setWorkflowAssetIds((current) => {
    const index = current.indexOf(assetId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= current.length) return current;
    const next = [...current];
    const currentValue = next[index];
    const targetValue = next[target];
    if (currentValue === undefined || targetValue === undefined) return current;
    next[index] = targetValue;
    next[target] = currentValue;
    return next;
  }), []);
  const displayTotal = isDemo ? 128 : catalogTotal;
  useEffect(() => {
    if (!catalogReady) return;
    const visibleIds = new Set(availablePhotos.map((photo) => photo.id));
    setSharedSelection((current) => {
      const retained = [...current.selectedIds].filter((id) => visibleIds.has(id));
      const preferred = selectedAssetId && visibleIds.has(selectedAssetId) ? selectedAssetId : retained.at(-1) ?? availablePhotos[0]?.id ?? null;
      if (retained.length === current.selectedIds.size && current.focusId === preferred) return current;
      const selectedIds = new Set(retained.length > 0 ? retained : preferred ? [preferred] : []);
      return { selectedIds, anchorId: selectedIds.has(current.anchorId ?? '') ? current.anchorId : preferred, focusId: preferred };
    });
  }, [availablePhotos, catalogReady, selectedAssetId]);
  const workspaceProps: LibraryWorkspaceProps = {
    view: 'library',
    active: !viewerPhoto,
    onOpenViewer: (assetId) => void openViewer(assetId),
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
    selection: sharedSelection,
    totalCount: displayTotal,
    favoriteOnly,
    sortBy,
    hasMore: nextCursor !== null,
    loadingMore,
    searchQuery,
    onSelectedAssetChange: setSelectedAssetId,
    onSelectionChange: setSharedSelection,
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
    onSynchronizeFolder: synchronizeFolder,
    onRevealFolder: revealFolder,
    onUnregisterFolder: unregisterFolder,
    onMoveFolder: moveFolder,
    onOpenTaskCenter: () => openWorkspaceTab('tasks'),
    onOpenTemplates: () => openWorkspaceTab('templates'),
    onAddAssetsToWorkflow: (ids) => { addAssetsToWorkflow(ids); openWorkspaceTab('batch'); },
    onAddAssetsToAgent: (ids) => { addAssetsToWorkflow(ids); setAgentDockOpen(true); },
    onAddAssetsToBatch: (ids) => { addAssetsToWorkflow(ids); openWorkspaceTab('batch'); }
  };
  const openViewer = async (assetId: string, assetIds?: string[], resultId: string | null = null) => {
    const request = ++viewerRequest.current;
    const origin = viewerOrigin.current ?? { focus: document.activeElement instanceof HTMLElement ? document.activeElement : null, drawerOpen: taskDrawerOpen };
    setViewerPreloading(true);
    try {
      const ids = [...new Set(assetIds ?? availablePhotos.map((item) => item.id))];
      if (!ids.includes(assetId)) ids.push(assetId);
      const byId = new Map(availablePhotos.map((item) => [item.id, item]));
      const missing = ids.filter((id) => !byId.has(id));
      for (let offset = 0; offset < missing.length; offset += 500) {
        const page = await window.desktopApi.listCatalogAssetPage({ assetIds: missing.slice(offset, offset + 500), limit: 500 });
        for (const item of mapCatalogAssets(page.items)) byId.set(item.id, item);
      }
      if (request !== viewerRequest.current) return;
      const photo = byId.get(assetId);
      if (!photo) {
        setNavigationNotice('该任务的图片已从图库移除，无法打开。');
        return;
      }
      if (photo.src) {
        const image = new window.Image();
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => { if (settled) return; settled = true; resolve(); };
          const decode = () => { void image.decode().then(() => { DECODED_IMAGE_SOURCES.add(photo.src!); if (image.naturalHeight > 0) IMAGE_ASPECT_RATIOS.set(photo.src!, image.naturalWidth / image.naturalHeight); finish(); }, finish); };
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
      if (request !== viewerRequest.current) return;
      viewerOrigin.current = origin;
      setViewerPhotos(ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []));
      setViewerPhoto(photo);
      setViewerResultId(resultId);
    } catch {
      if (request === viewerRequest.current) setNavigationNotice('无法读取图片，请检查图库和原文件是否可用。');
    } finally {
      if (request === viewerRequest.current) setViewerPreloading(false);
    }
  };
  openViewerRef.current = (assetId, assetIds) => { void openViewer(assetId, assetIds); };

  const unregisterFromNavigation = async (folderId: string) => {
    const folder = catalogFolders.find((item) => item.id === folderId);
    await unregisterFolder(folderId);
    setNavigationNotice(`已从图库移除「${folder?.name ?? '文件夹'}」，磁盘文件和已有元数据保持不变。`);
  };
  const dropAssetsFromNavigation = async (folderId: string, assetIds: string[], copy: boolean) => {
    if (isDemo || assetIds.length === 0) return;
    try {
      const companions = await window.desktopApi.previewCatalogCompanions(assetIds);
      const report = copy
        ? await window.desktopApi.copyCatalogAssets({ assetIds, targetFolderId: folderId, includeCompanions: false })
        : await window.desktopApi.moveCatalogAssets({ assetIds, targetFolderId: folderId, includeCompanions: false });
      if (report.status !== 'completed') setNavigationNotice(report.rolledBack ? '拖放操作失败，文件已恢复到原位置。' : `拖放操作未能完整恢复，请记录操作号 ${report.operationId}。`);
      else if ('copied' in report) setNavigationNotice(`已复制 ${report.copied} 张照片${companions.files.length ? `；另有 ${companions.files.length} 个 RAW/JPEG/XMP 关联文件未复制` : ''}。`);
      else setNavigationNotice(`已移动 ${report.moved} 张照片${report.skipped ? `，${report.skipped} 张原本就在目标文件夹` : ''}${companions.files.length ? `；另有 ${companions.files.length} 个 RAW/JPEG/XMP 关联文件未移动` : ''}。`);
      await refreshCatalog();
    } catch {
      setNavigationNotice('拖放操作失败：请检查目标文件夹权限、磁盘状态或所选照片的活动任务。');
    }
  };

  return (
    <div className="app-shell">
      <AppHeader active={activeTab} openTabs={openTabs} onChange={setActiveTab} onClose={closeWorkspaceTab} onOpen={openWorkspaceTab} onImport={() => void importFolders()} search={searchDraft} onSearchChange={setSearchDraft} />
      {!sessionReady || !catalogReady ? <main className="workspace-loading"><span className="working-pulse" /><span>{sessionReady ? '正在读取图库' : '正在恢复工作区'}</span></main>
        : <div className="global-workspace-shell" style={{ gridTemplateColumns: `${panelVisibility.left ? globalLayout.leftWidth : 0}px ${panelVisibility.left ? 5 : 0}px minmax(0, 1fr) ${panelVisibility.right ? 5 : 0}px ${panelVisibility.right ? globalLayout.rightWidth : 0}px` }}>
              <div className="workspace-side-panel" hidden={!panelVisibility.left}><Sidebar folders={catalogFolders} albums={catalogAlbums} smartCollections={catalogSmartCollections} totalCount={catalogTotal} selectedFolderId={selectedFolderId} selectedAlbumId={selectedAlbumId} selectedSmartCollection={selectedSmartCollection} tags={catalogTags} selectedTagId={selectedTagId} onSelectFolder={workspaceProps.onSelectFolder} onSelectAlbum={workspaceProps.onSelectAlbum} onSelectSmartCollection={workspaceProps.onSelectSmartCollection} onRefreshAlbums={refreshCatalog} onImportFolders={importFolders} onRelinkFolder={relinkFolder} onSynchronizeFolder={synchronizeFolder} onRevealFolder={revealFolder} onUnregisterFolder={unregisterFromNavigation} onMoveFolder={moveFolder} onDropAssets={dropAssetsFromNavigation} onSelectTag={setSelectedTagId} isDemo={isDemo} /></div>
              <div className="workspace-side-splitter" hidden={!panelVisibility.left}><PaneSplitter orientation="vertical" value={globalLayout.leftWidth} minimum={160} maximum={420} label="调整左侧目录栏宽度" onChange={(value) => setGlobalLayout('leftWidth', value)} /></div>
              <div className="workspace-page-stack">
              <div className="workspace-source-page" inert={Boolean(viewerPhoto)} aria-hidden={viewerPhoto ? true : undefined} style={viewerPhoto ? { visibility: 'hidden' } : undefined}>
              {activeTab === 'library' ? <LibraryWorkspace {...workspaceProps} />
                : activeTab === 'batch' || activeTab === 'workflow' ? <AiWorkflowPage photos={availablePhotos} selectedIds={sharedSelection.selectedIds} focusId={sharedSelection.focusId} workflowAssetIds={workflowAssetIds} workflowAssetMeta={workflowAssetMeta} tasks={globalTasks} globalRules={workflowRules} onGlobalRulesChange={setWorkflowRules} templateId={workflowTemplateId} onAddAssets={addAssetsToWorkflow} onRemoveAsset={removeWorkflowAsset} onMoveAsset={moveWorkflowAsset} onClearAssets={() => { setWorkflowAssetIds([]); setWorkflowAssetMeta({}); }} onOpenTasks={() => openWorkspaceTab('tasks')} onOpenViewer={(assetId, assetIds, resultId) => void openViewer(assetId, assetIds, resultId)} onFocusAsset={(id) => setSharedSelection((current) => ({ ...current, focusId: id }))} />
                : activeTab === 'settings' ? <SettingsPage onExportPresetsChange={setExportPresets} />
                  : activeTab === 'tasks' ? <TaskCenterPage onCatalogChanged={refreshCatalog} onOpenViewer={(assetId, assetIds) => void openViewer(assetId, assetIds)} photos={availablePhotos} />
                    : <TemplatePage />}
              </div>
              {viewerPhoto && <InlinePhotoViewer workspace={workspaceProps} photo={viewerPhoto} items={viewerPhotos} onPhotoChange={(photo) => { setViewerPhoto(photo); setViewerResultId(null); }} onClose={closeViewer} resultId={viewerResultId} />}
              {viewerPreloading && <div className="viewer-preload-indicator" role="status"><span className="working-pulse" />正在准备预览</div>}
              </div>
              <div className="workspace-side-splitter" hidden={!panelVisibility.right}><PaneSplitter orientation="vertical" value={globalLayout.rightWidth} minimum={240} maximum={520} label="调整右侧 AI 面板宽度" invert onChange={(value) => setGlobalLayout('rightWidth', value)} /></div>
              <div hidden={!panelVisibility.right} className={`workspace-side-panel right-dock-stack${dockLayout.collapsed ? ' is-collapsed' : ''}`}>
                <div className="inspector unified-dock">
                  <div className="inspector-tabs"><button className={dockTab === 'ai' ? 'is-active' : ''} type="button" onClick={() => { setDockTab('ai'); setAgentDockOpen(false); }}><Bot size={14} />AI</button><button className={dockTab === 'agent' ? 'is-active' : ''} type="button" onClick={() => { setDockTab('agent'); setAgentDockOpen(true); }}><Sparkles size={14} />Agent</button><button className={dockTab === 'details' ? 'is-active' : ''} type="button" onClick={() => { setDockTab('details'); setAgentDockOpen(false); }}><Info size={14} />详情</button></div>
                  <div className="inspector-scroll">{dockTab === 'agent' ? <AgentDockPanel selectedIds={contextSelectedIds} photos={contextPhotos} onClose={() => { setDockTab('ai'); setAgentDockOpen(false); }} onOpenBatch={() => openWorkspaceTab('batch')} onCollapse={() => saveDockLayout({ ...dockLayout, collapsed: true })} onMove={() => saveDockLayout({ ...dockLayout, order: ['details', 'agent'] })} /> : dockTab === 'details' && globalFocusPhoto ? <div className="inspector-details"><InspectorInfo photo={globalFocusPhoto} revision={undefined} /><InspectorVersions results={[]} trashedResults={[]} onTrashResult={async () => undefined} onRestoreResult={async () => undefined} /></div> : <GlobalAiPanel onOpenBatch={() => openWorkspaceTab('batch')} photo={globalFocusPhoto} selectedIds={contextSelectedIds} isDemo={isDemo} workspaceTab={activeTab} onOpenTemplates={() => openWorkspaceTab('templates')} onAddAssetsToWorkflow={addAssetsToWorkflow} workflowAssetIds={workflowAssetIds} tasks={globalTasks} workflowRules={workflowRules} onWorkflowRulesChange={setWorkflowRules} workflowTemplateId={workflowTemplateId} onWorkflowTemplateChange={setWorkflowTemplateId} />}</div>
                </div>
                {dockLayout.collapsed && <button className="dock-restore" type="button" onClick={() => saveDockLayout({ ...dockLayout, collapsed: false })}>展开 Dock 面板</button>}
              </div>
              {navigationNotice && <div className="operation-toast global-navigation-notice" role="status">{navigationNotice}<button type="button" aria-label="关闭提示" onClick={() => setNavigationNotice('')}><X size={13} /></button></div>}
            </div>}
      <TaskBar panelVisibility={panelVisibility} onTogglePanel={(side) => { panelsBeforeHide.current = null; setPanelVisibility((current) => ({ ...current, [side]: !current[side] })); }} suspended={Boolean(viewerPhoto)} open={taskDrawerOpen} onToggle={() => setTaskDrawerOpen((value) => !value)} onOpenTaskCenter={() => { setTaskDrawerOpen(false); openWorkspaceTab('tasks'); }} onOpenViewer={(assetId, assetIds) => void openViewer(assetId, assetIds)} tasks={isDemo ? null : globalTasks} counts={globalTaskCounts} photos={availablePhotos} />
    </div>
  );
}
