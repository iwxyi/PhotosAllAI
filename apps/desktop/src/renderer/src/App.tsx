import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ViewerToolbar } from './viewer-toolbar';
import { AgentPanel } from './agent-panel';
import { useTransientNotice } from './use-transient-notice';
import { CatalogBrowseControls } from './catalog-browse-controls';
import { emptyBrowseFilters, groupCatalogPhotos, metadataDimensions, type BrowseFilters } from './catalog-browse';
import { ViewerZoomControl } from './viewer-zoom-control';
import { actualPixelZoom, boundPan, zoomAround } from './viewer-geometry';
import { FileWorkflowControl, FileWorkflowEditor } from './file-workflow-editor';
import type {
  CatalogAsset,
  FileDetails,
  QuickViewSession,
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
  McpStatus,
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
import { composeGenerationPrompt, pickExportResults, selectAll, updateSelection, type ExportSelectionMode, type SelectionIntent, type SelectionState } from '@photoallisai/domain';
import { getLocale, setLocale, t, useLocale, type Locale } from './i18n';
import {
  Aperture,
  Flag,
  ArrowUp,
  ArrowDown,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Columns2,
  PanelsTopLeft,
  Command,
  Copy,
  ExternalLink,
  Download,
  FilePenLine,
  Folder,
  FolderHeart,
  FolderInput,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  GalleryHorizontalEnd,
  Grid2X2,
  Heart,
  History,
  Image,
  LoaderCircle,
  Info,
  KeyRound,
  Layers3,
  LibraryBig,
  ListFilter,
  Maximize2,
  Plus,
  Plug,
  Search,
  Server,
  Settings,
  RotateCcw,
  Rows3,
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
import { analysisFailureMessage, generationFailureMessage, fileOperationFailureMessage } from './error-messages';

const THEME_CHANGE_EVENT = 'photoallisai-theme-change';
const CATALOG_FILE_NAME_CENTERED_KEY = 'photoallisai.catalog-file-name-centered';
const VIEWER_VERSION_TARGET_KEY = 'photoallisai.viewer-version-target';
const ANALYSIS_DETAILS_OPEN_KEY = 'photoallisai.analysis-details-open';
const OPEN_TASK_DRAWER_EVENT = 'photoallisai-open-task-drawer';
const OPERATION_NOTICE_EVENT = 'photoallisai-operation-notice';
const E2E_DEMO_MODE = new URLSearchParams(window.location.search).get('e2e-demo') === '1';
const DECODED_IMAGE_SOURCES = new Set<string>();
const IMAGE_ASPECT_RATIOS = new Map<string, number>();
const VIEWER_IMAGE_PRELOADS = new Map<string, HTMLImageElement>();
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

function applyCatalogFileNameAlignment(centered: boolean): void {
  document.documentElement.dataset.catalogFileNameCentered = String(centered);
}

function catalogFileNameCentered(): boolean {
  try { return localStorage.getItem(CATALOG_FILE_NAME_CENTERED_KEY) !== 'false'; }
  catch { return true; }
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
      filmstripHeight: clamp(Number(saved.filmstripHeight) || DEFAULT_VIEWER_LAYOUT.filmstripHeight, 72, 320)
    };
  } catch {
    return DEFAULT_VIEWER_LAYOUT;
  }
}

function useViewerLayout(): [ViewerLayout, (key: keyof ViewerLayout, value: number) => void] {
  const [layout, setLayout] = useState<ViewerLayout>(loadViewerLayout);
  const update = useCallback((key: keyof ViewerLayout, value: number) => {
    const limits = key === 'leftWidth' ? [160, 420] : key === 'rightWidth' ? [240, 520] : [72, 320];
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
  const [showLoading, setShowLoading] = useState(false);
  const [ready, setReady] = useState(() => DECODED_IMAGE_SOURCES.has(src));
  const onReadyRef = useRef(onReady);
  useLayoutEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => {
    if (!src || src === displayed.src || src === failedSrc) return;
    let active = true;
    setShowLoading(false);
    const indicatorTimer = window.setTimeout(() => { if (active) setShowLoading(true); }, 1_100);
    const image = new window.Image();
    image.onload = async () => {
      try {
        await image.decode();
      } catch {
        // onload already proved the image is usable; decode can reject for cached images.
      }
      if (!active) return;
      DECODED_IMAGE_SOURCES.add(src);
      if (image.naturalHeight > 0) IMAGE_ASPECT_RATIOS.set(src, image.naturalWidth / image.naturalHeight);
      onReadyRef.current?.(image);
      setDisplayed({ src, alt });
      setFailedSrc(null);
      window.clearTimeout(indicatorTimer);
      setShowLoading(false);
      setReady(true);
    };
    image.onerror = () => {
      if (!active) return;
      setFailedSrc(src);
      window.clearTimeout(indicatorTimer);
      setShowLoading(false);
    };
    image.src = src;
    return () => { active = false; window.clearTimeout(indicatorTimer); };
  }, [alt, displayed.src, failedSrc, src]);
  return <>{displayed.src ? <img className={`${className} buffered-image${ready ? ' is-ready' : ''}`} src={displayed.src} alt={displayed.alt} onLoad={(event) => { DECODED_IMAGE_SOURCES.add(displayed.src); if (event.currentTarget.naturalHeight > 0) IMAGE_ASPECT_RATIOS.set(displayed.src, event.currentTarget.naturalWidth / event.currentTarget.naturalHeight); setReady(true); onReadyRef.current?.(event.currentTarget); }} /> : null}{showLoading && <span className="preview-loading" aria-label="正在载入下一张照片"><span className="working-pulse" /></span>}</>;
}

const catalogImageVisibility = new Map<Element, (visible: boolean) => void>();
let catalogImageObserver: IntersectionObserver | undefined;

function CatalogImage({ src, previewSrc, alt = '', onAspectRatio }: { src: string; previewSrc?: string; alt?: string; onAspectRatio?: (ratio: number) => void }): React.JSX.Element {
  const ref = useRef<HTMLImageElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [requestedSrc, setRequestedSrc] = useState<string | undefined>();
  const [displayed, setDisplayed] = useState<{ base: string; src: string; ready: boolean }>();
  const [needsPreview, setNeedsPreview] = useState(false);
  const onAspectRatioRef = useRef(onAspectRatio);
  useLayoutEffect(() => { onAspectRatioRef.current = onAspectRatio; }, [onAspectRatio]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    catalogImageObserver ??= new IntersectionObserver((entries) => {
      for (const entry of entries) catalogImageVisibility.get(entry.target)?.(entry.isIntersecting);
    }, { rootMargin: '300px' });
    catalogImageVisibility.set(element, setNearViewport);
    catalogImageObserver.observe(element);
    return () => { catalogImageObserver?.unobserve(element); catalogImageVisibility.delete(element); };
  }, []);
  useEffect(() => {
    if (nearViewport) setRequestedSrc(src);
  }, [nearViewport, src]);
  useEffect(() => {
    const element = ref.current;
    if (!element || !previewSrc || !nearViewport) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      const ratio = IMAGE_ASPECT_RATIOS.get(src);
      const longEdge = ratio ? Math.max(Math.min(width, height * ratio), Math.min(height, width / ratio)) : Math.max(width, height);
      setNeedsPreview(longEdge * window.devicePixelRatio > 384);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [nearViewport, previewSrc, src, displayed?.ready]);
  useEffect(() => {
    if (!previewSrc || !nearViewport || !needsPreview || displayed?.base !== src || !displayed.ready || displayed.src === previewSrc) return;
    let active = true;
    const image = new window.Image();
    // Wait for zoom gestures to settle before requesting a larger disk preview.
    const timer = window.setTimeout(() => {
      image.onload = async () => {
        try { await image.decode(); } catch { /* A loaded image remains usable if decode rejects. */ }
        if (active) setDisplayed({ base: src, src: previewSrc, ready: true });
      };
      image.src = previewSrc;
    }, 180);
    return () => { active = false; window.clearTimeout(timer); image.onload = null; image.onerror = null; };
  }, [displayed, nearViewport, needsPreview, previewSrc, src]);
  const current = displayed?.base === src ? displayed : undefined;
  return <img ref={ref} className={current?.ready ? 'is-ready' : ''} src={current?.src ?? (requestedSrc === src ? src : undefined)} alt={alt} decoding="async" onLoad={(event) => {
    const image = event.currentTarget;
    if (!image.getAttribute('src')) return;
    setDisplayed((previous) => previous?.base === src && previous.ready ? previous : { base: src, src, ready: true });
    if (image.naturalHeight > 0) {
      const ratio = image.naturalWidth / image.naturalHeight;
      IMAGE_ASPECT_RATIOS.set(src, ratio);
      onAspectRatioRef.current?.(ratio);
    }
  }} />;
}

type CompareMode = 'single' | 'split';
type CatalogSort = 'modifiedAt' | 'fileName' | 'rating';
type CatalogViewMode = 'list' | 'grid' | 'masonry' | 'justified';
const photoColorNames: Record<NonNullable<Photo['labelColor']>, string> = { red: '红色', yellow: '黄色', green: '绿色', blue: '蓝色', purple: '紫色' };
const photoColorName = (color: Photo['labelColor']): string => color ? photoColorNames[color] : '无';
function ContextMenuSurface({ children, style, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const position = () => {
      const bounds = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(Number(style?.left) || 8, window.innerWidth - bounds.width - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(Number(style?.top) || 8, window.innerHeight - bounds.height - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    window.addEventListener('resize', position);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); };
  }, [style?.left, style?.top]);
  return createPortal(<div {...props} ref={ref} style={{ ...style, zIndex: 1100, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' }}>{children}</div>, document.body);
}

function PhotoFlag({ photo }: { photo: Photo }): React.JSX.Element | null {
  if (!photo.flag || photo.flag === 'unflagged') return null;
  return <span className={`photo-flag-badge is-${photo.flag}`} aria-label={photo.flag === 'picked' ? '留用' : '排除'}><Flag size={12} fill="currentColor" />{photo.flag === 'rejected' && <X size={9} />}</span>;
}
const catalogColumns = [
  { id: 'thumbnail', label: '缩略图', width: '58px' },
  { id: 'name', label: '文件', width: 'minmax(160px, 1fr)' },
  { id: 'format', label: '格式', width: '70px' },
  { id: 'rating', label: '评分', width: '70px' },
  { id: 'tags', label: '标签', width: '160px' },
  { id: 'analysis', label: '分析', width: '260px' },
  { id: 'suggestions', label: '建议', width: '260px' }
] as const;
type CatalogColumn = typeof catalogColumns[number]['id'];

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
    folderId: asset.directoryId ?? asset.folderId,
    ...(asset.relativePath ? { relativePath: asset.relativePath } : {}),
    modifiedAt: asset.modifiedAt,
    sizeBytes: asset.sizeBytes,
    fileName: asset.fileName,
    src: asset.previewUrl,
    ...(['JPG', 'JPEG', 'PNG', 'WEBP', 'GIF', 'AVIF', 'BMP', 'ICO'].includes(asset.format.toUpperCase()) ? { originalSrc: asset.previewUrl.replace('://preview/', '://original/') } : {}),
    thumbnailSrc: asset.thumbnailUrl,
    format: asset.format,
    dimensions: `${(asset.sizeBytes / 1_048_576).toFixed(1)} MB`,
    rating: asset.rating,
    labelColor: asset.labelColor,
    flag: asset.flag,
    favorite: asset.favorite,
    tags: asset.tags,
    offline: asset.offline,
    ...(asset.workflow ? { workflow: asset.workflow } : {}),
    ...(asset.workflowConflict ? { workflowConflict: true } : {})
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
  const [inlineFolderRename, setInlineFolderRename] = useState(false);
  const folderRenameLock = useRef(false);
  const [folderAppearance, setFolderAppearance] = useState<FolderAppearance>(loadFolderAppearance);
  const [folderContextMenu, setFolderContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [folderActionBusy, setFolderActionBusy] = useState(false);
  const [folderActionNotice, setFolderActionNotice] = useTransientNotice();
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
    if (!folderRenameCandidate || !folderRenameDraft.trim() || folderRenameLock.current) return;
    folderRenameLock.current = true;
    setFolderRenameBusy(true);
    try {
      const { folder } = await window.desktopApi.renameCatalogFolder({ folderId: folderRenameCandidate.id, name: folderRenameDraft.trim() });
      setFolderRenameCandidate(null);
      setInlineFolderRename(false);
      await onRefreshAlbums();
      onSelectFolder(folder.id);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-folder-id="${CSS.escape(folder.id)}"]`)?.focus());
    } catch (error) {
      setFolderActionNotice(error instanceof Error && error.message.includes('FOLDER_NAME_ALREADY_EXISTS') ? '重命名失败：同级目录中已存在同名文件夹。' : '重命名失败，请检查文件夹权限。');
    } finally { folderRenameLock.current = false; setFolderRenameBusy(false); }
  };
  const startFolderRename = (folder: CatalogFolder) => {
    setFolderContextMenu(null);
    setFolderActionNotice('');
    setFolderRenameCandidate(folder);
    setFolderRenameDraft(folder.name);
    setInlineFolderRename(true);
  };
  const createFolder = async (parentId: string) => {
    if (folderActionBusy) return;
    setFolderActionBusy(true);
    setFolderContextMenu(null);
    setFolderActionNotice('');
    try {
      const { folder } = await window.desktopApi.createCatalogFolder({ parentFolderId: parentId });
      await onRefreshAlbums();
      setFolderAppearance((current) => ({ ...current, sectionCollapsed: false, expandedIds: [...new Set([...current.expandedIds, parentId])] }));
      onSelectFolder(folder.id);
      setInlineFolderRename(true);
      setFolderRenameCandidate(folder);
      setFolderRenameDraft(folder.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFolderActionNotice(message.includes('EACCES') || message.includes('EPERM') ? '创建失败：没有该文件夹的写入权限。' : `创建文件夹失败：${message.replace(/^Error invoking remote method [^:]+: /u, '').slice(0, 120)}`);
    } finally { setFolderActionBusy(false); }
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
            <span>收藏</span>
            <span className="row-count">{favoriteCount}</span>
          </button>
        </nav>

        <div className="sidebar-section">
          <div className="section-heading">
            <button className="section-disclosure" type="button" aria-label={folderAppearance.sectionCollapsed ? '展开关联文件夹区域' : '收起关联文件夹区域'} aria-expanded={!folderAppearance.sectionCollapsed} onClick={() => setFolderAppearance((current) => ({ ...current, sectionCollapsed: !current.sectionCollapsed }))}><ChevronRight size={12} /><span>关联文件夹</span></button>
            <span><button type="button" aria-label="创建子文件夹" title="在选中的文件夹内创建子文件夹" disabled={isDemo || !selectedFolderId || folderActionBusy} onClick={() => { if (selectedFolderId) void createFolder(selectedFolderId); }}><FolderInput size={13} /></button>{selectedOfflineFolder && <button type="button" aria-label={`重新定位 ${selectedOfflineFolder.name}`} title="重新定位离线文件夹" onClick={() => void onRelinkFolder(selectedOfflineFolder.id)}><RotateCcw size={13} /></button>}<button type="button" aria-label="添加关联文件夹" onClick={() => void onImportFolders()}><Plus size={13} /></button></span>
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
                } else if (event.key === 'F2' && !isDemo) { event.preventDefault(); startFolderRename(folder); }
                else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectFolder(folder.id); }
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
                {inlineFolderRename && folderRenameCandidate?.id === folder.id ? <input className="folder-inline-name" aria-label="文件夹名称" autoFocus value={folderRenameDraft} disabled={folderRenameBusy} onFocus={(event) => { event.currentTarget.select(); event.currentTarget.scrollIntoView({ block: 'nearest' }); }} onChange={(event) => setFolderRenameDraft(event.target.value)} onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onBlur={() => { if (folderRenameDraft.trim()) void renameFolder(); else { setFolderRenameCandidate(null); setInlineFolderRename(false); } }} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); void renameFolder(); } else if (event.key === 'Escape') { event.preventDefault(); setFolderRenameCandidate(null); setInlineFolderRename(false); } }} /> : <span>{folder.name}</span>}
                <span className="row-count">{folder.offlineCount > 0 ? `离线 ${folder.offlineCount}` : folder.assetCount}</span>
              </button>
            </div>;
          })}
          </div>}
          {folderContextMenu && contextFolder && <div className="folder-context-menu" role="menu" aria-label={`文件夹菜单 ${contextFolder.name}`} style={{ left: Math.min(folderContextMenu.x, Math.max(8, window.innerWidth - 224)), top: Math.min(folderContextMenu.y, Math.max(8, window.innerHeight - 286)) }} onPointerDown={(event) => event.stopPropagation()}>
            <div className="folder-menu-title"><Folder size={14} /><span>{contextFolder.name}</span></div>
            <button type="button" role="menuitem" onClick={() => { onSelectFolder(contextFolder.id); setFolderContextMenu(null); }}><GalleryHorizontalEnd size={14} /><span>在图库中显示</span></button>
            <button type="button" role="menuitem" disabled={isDemo || folderActionBusy} onClick={() => void createFolder(contextFolder.id)}><FolderPlus size={14} /><span>创建子文件夹</span></button>
            <button type="button" role="menuitem" disabled={isDemo} onClick={() => startFolderRename(contextFolder)}><FilePenLine size={14} /><span>重命名</span></button>
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
            {isDemo ? <><span>人像</span><span>夜景</span><span>街拍</span><span>自然光</span></> : tags.length === 0 ? <small className="sidebar-empty">暂无标签</small> : tags.map((tag) => <button className={selectedTagId === tag.id ? 'is-active' : ''} type="button" key={tag.id} onClick={() => onSelectTag(selectedTagId === tag.id ? null : tag.id)}>{tag.name}<em>{tag.assetCount}</em></button>)}
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
      {albumDeleteCandidate && <div className="modal-backdrop sidebar-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !albumBusy) setAlbumDeleteCandidate(null); }}><section className="removal-dialog" role="alertdialog" aria-modal="true" aria-labelledby="album-removal-title"><header><span className="dialog-icon"><Trash2 size={17} /></span><div><h2 id="album-removal-title">删除相册「{albumDeleteCandidate.name}」？</h2><p>只删除相册及其照片关系，不会删除或移动任何原图和 AI 生成版本。</p></div></header><div className="removal-impact"><Info size={15} /><span>相册内的 {albumDeleteCandidate.assetCount} 张照片仍会保留在图库和原文件夹中。</span></div><footer><button autoFocus className="quiet-button" type="button" disabled={albumBusy} onClick={() => setAlbumDeleteCandidate(null)}>取消</button><button className="danger-action" type="button" disabled={albumBusy} onClick={async () => { setAlbumBusy(true); try { await window.desktopApi.deleteCatalogAlbum(albumDeleteCandidate.id); if (selectedAlbumId === albumDeleteCandidate.id) onSelectAlbum(null); await onRefreshAlbums(); setAlbumDeleteCandidate(null); } finally { setAlbumBusy(false); } }}>{albumBusy ? '正在删除…' : '删除相册'}</button></footer></section></div>}
      {folderActionNotice && <div className="operation-toast" role="status">{folderActionNotice}<button type="button" aria-label="关闭文件夹提示" onClick={() => setFolderActionNotice('')}><X size={13} /></button></div>}
    </aside>
  );
}

type FilmstripMenuOptions = {
  display: { flags: boolean; ratings: boolean; names: boolean };
  onDisplayChange: (key: 'flags' | 'ratings' | 'names') => void;
  viewMode: 'filmstrip' | 'grid';
  onViewModeChange: (mode: 'filmstrip' | 'grid') => void;
  sortBy: CatalogSort;
  onSortByChange: (value: CatalogSort) => void;
  temporary: boolean;
};

function FilmstripMenu({ options, onClose }: { options: FilmstripMenuOptions; onClose: () => void }): React.JSX.Element {
  return <>
    <span className="folder-menu-separator" />
    {(['flags', 'ratings', 'names'] as const).map((key) => <button type="button" role="menuitemcheckbox" aria-checked={options.display[key]} key={key} onClick={() => { options.onDisplayChange(key); onClose(); }}><span className="menu-check-slot">{options.display[key] && <Check size={13} />}</span><span>{key === 'flags' ? '显示旗标' : key === 'ratings' ? '显示星级' : '显示文件名'}</span></button>)}
    <span className="folder-menu-separator" />
    <div className="folder-menu-title">胶片布局</div>
    {(['filmstrip', 'grid'] as const).map((mode) => <button type="button" role="menuitemradio" aria-checked={options.viewMode === mode} key={mode} onClick={() => { options.onViewModeChange(mode); onClose(); }}>{mode === 'filmstrip' ? <GalleryHorizontalEnd size={14} /> : <Grid2X2 size={14} />}<span>{mode === 'filmstrip' ? '横向胶片' : '网格'}</span>{options.viewMode === mode && <Check size={13} />}</button>)}
    {!options.temporary && <label className="filmstrip-menu-sort">排序<select aria-label="胶片排序" value={options.sortBy} onChange={(event) => { options.onSortByChange(event.target.value as CatalogSort); onClose(); }}><option value="modifiedAt">修改时间</option><option value="fileName">文件名</option><option value="rating">评分</option></select></label>}
  </>;
}

type PhotoFilters = BrowseFilters & {
  minimumRating: number | null;
  ratingOperator: 'eq' | 'gte' | 'lte';
  flags: NonNullable<Photo['flag']>[];
  colors: NonNullable<Photo['labelColor']>[];
};
const emptyPhotoFilters: PhotoFilters = { ...emptyBrowseFilters, minimumRating: null, ratingOperator: 'gte', flags: [], colors: [] };

function PhotoFilterBar({ leading, onReset, compact = false, scope, search, setSearch, minimumRating, setMinimumRating, ratingOperator, setRatingOperator, flags, setFlags, colors, setColors, onlyFavorites, setOnlyFavorites, favoriteOnly, onFavoriteOnlyChange, temporary = false, renderTools }: {
  renderTools?: (tools: Record<string, React.ReactNode>) => React.ReactNode;
  leading?: React.ReactNode;
  onReset?: (() => void) | undefined;
  compact?: boolean;
  scope: string;
  search: string;
  setSearch: (value: string) => void;
  minimumRating: number | null;
  setMinimumRating: React.Dispatch<React.SetStateAction<number | null>>;
  ratingOperator: PhotoFilters['ratingOperator'];
  setRatingOperator: (value: PhotoFilters['ratingOperator']) => void;
  flags: PhotoFilters['flags'];
  setFlags: React.Dispatch<React.SetStateAction<PhotoFilters['flags']>>;
  colors: PhotoFilters['colors'];
  setColors: React.Dispatch<React.SetStateAction<PhotoFilters['colors']>>;
  onlyFavorites: boolean;
  setOnlyFavorites: (value: boolean) => void;
  favoriteOnly: boolean;
  onFavoriteOnlyChange: (value: boolean) => void;
  temporary?: boolean;
}): React.JSX.Element {
  const [searchOpen, setSearchOpen] = useState(false);
  const filtered = Boolean(search.trim() || minimumRating !== null || flags.length || colors.length || onlyFavorites || favoriteOnly);
  const tools: Record<string, React.ReactNode> = {
    search: !compact || searchOpen || search ? <input autoFocus={compact} aria-label={"筛选" + scope + "文件名"} placeholder="文件名" value={search} onChange={(event) => setSearch(event.target.value)} onBlur={() => { if (!search.trim()) setSearchOpen(false); }} /> : <button type="button" aria-label={"筛选" + scope + "文件名"} title="筛选文件名" onClick={() => setSearchOpen(true)}><Search size={13} /></button>,
    stars: !temporary && <div className="filmstrip-filter-stars" role="group" aria-label={scope + "星级筛选"}><select aria-label="星级筛选条件" value={ratingOperator} onChange={(event) => setRatingOperator(event.target.value as typeof ratingOperator)}><option value="eq">＝</option><option value="gte">≥</option><option value="lte">≤</option></select>{[1, 2, 3, 4, 5].map((rating) => <button type="button" key={rating} aria-label={`${ratingOperator === 'eq' ? '等于' : ratingOperator === 'lte' ? '至多' : '至少'} ${rating} 星`} title={`${rating} 星，再次点击取消`} aria-pressed={minimumRating === rating} className={(minimumRating ?? 0) >= rating ? 'is-filled' : ''} onClick={() => setMinimumRating((current) => current === rating ? null : rating)}><Star size={13} fill={(minimumRating ?? 0) >= rating ? 'currentColor' : 'none'} /></button>)}</div>,
    flags: !temporary && <div className="filmstrip-filter-colors" role="group" aria-label="筛选旗标">{(['picked', 'rejected', 'unflagged'] as const).map((flag) => <button type="button" key={flag} aria-label={`筛选${flag === 'picked' ? '留用' : flag === 'rejected' ? '排除' : '无旗标'}`} title={flag === 'picked' ? '留用 (P)' : flag === 'rejected' ? '排除 (X)' : '无旗标 (U)'} aria-pressed={flags.includes(flag)} className={flags.includes(flag) ? 'is-active' : ''} onClick={() => setFlags((current) => current.includes(flag) ? current.filter((value) => value !== flag) : [...current, flag])}>{flag === 'rejected' ? <span className="photo-flag-cross"><Flag size={13} fill="currentColor" /><X size={9} /></span> : <Flag size={13} fill={flag === 'picked' ? 'currentColor' : 'none'} />}</button>)}</div>,
    colors: !temporary && <div className="filmstrip-filter-colors" role="group" aria-label="筛选颜色">{(['red', 'yellow', 'green', 'blue', 'purple'] as const).map((color) => <button type="button" key={color} aria-label={`筛选${photoColorName(color)}标签`} aria-pressed={colors.includes(color)} className={colors.includes(color) ? 'is-active' : ''} onClick={() => setColors((current) => current.includes(color) ? current.filter((value) => value !== color) : [...current, color])}><i className={`photo-color-swatch is-${color}`} /></button>)}</div>,
    favorites: !temporary && <button className={onlyFavorites || favoriteOnly ? 'is-active' : ''} type="button" aria-label="仅显示收藏照片" aria-pressed={onlyFavorites || favoriteOnly} title="仅显示收藏照片" onClick={() => { if (favoriteOnly) onFavoriteOnlyChange(false); setOnlyFavorites(!(onlyFavorites || favoriteOnly)); }}><Heart size={13} /></button>,
    reset: <IconButton label={"重置" + scope + "过滤器"} disabled={!filtered && (!onReset || Boolean(leading))} onClick={() => { setSearchOpen(false); setSearch(''); setMinimumRating(null); setFlags([]); setColors([]); setOnlyFavorites(false); if (favoriteOnly) onFavoriteOnlyChange(false); if (!leading) onReset?.(); }}><RotateCcw size={13} /></IconButton>
  };
  if (renderTools) return <>{renderTools(tools)}</>;
  return <div className={`filmstrip-filter-bar${leading ? ' has-grouping' : ''}${compact ? ' is-inline' : ''}`} role="group" aria-label={scope + "过滤条件"}>{leading}<div className="photo-filter-controls">{Object.entries(tools).map(([id, tool]) => <Fragment key={id}>{tool}</Fragment>)}</div></div>;
}

function resolveViewerVersion(photo: Photo, results: GenerationResult[], target: string) {
  const members = photo.workflow?.members ?? [];
  const stages = photo.workflow?.stages ?? [...new Map(members.map((member) => [member.stageId, { id: member.stageId, name: member.stageName }])).values()];
  const rawMember = members.find((item) => isRawPhoto(item.asset) && !item.asset.offline);
  const latestBatchId = [...results].sort((a, b) => b.createdAt - a.createdAt || b.version - a.version)[0]?.batchId;
  const result = target === 'preferred-ai' ? results.find((item) => item.reviewState === 'preferred')
    : target === 'latest-ai' ? results.filter((item) => item.batchId === latestBatchId).sort((a, b) => a.version - b.version)[0] : undefined;
  const stageId = target.startsWith('stage:') ? target.slice(6) : null;
  const stageIndex = stages.findIndex((stage) => stage.id === stageId);
  const member = target === 'raw' ? rawMember ?? members.find((item) => !item.asset.offline) : stageId ? stages.slice(0, Math.max(0, stageIndex) + 1).reverse()
    .flatMap((stage) => members.filter((item) => item.stageId === stage.id && !item.asset.offline).sort((a, b) => Number(isRawPhoto(a.asset)) - Number(isRawPhoto(b.asset))))[0] ?? members[0]
    : !result ? [...members].reverse().find((item) => !item.asset.offline && !isRawPhoto(item.asset) && !/\bAI\b|人工智能|生成/u.test(item.stageName)) ?? members.at(-1) : undefined;
  return { stages, result, member, rawMember };
}

const RAW_IMAGE_EXTENSIONS = /\.(?:dng|cr2|cr3|nef|nrw|arw|raf|rw2|orf|pef)$/iu;
function isRawPhoto(photo: Pick<Photo, 'fileName' | 'format'>): boolean {
  return RAW_IMAGE_EXTENSIONS.test(photo.fileName) || photo.format.toUpperCase() === 'RAW';
}

const VERSION_TARGET_CHANGED_EVENT = 'photoallisai:version-target-changed';

function readVersionTarget(): string {
  try { return localStorage.getItem(VIEWER_VERSION_TARGET_KEY) ?? 'latest-ai'; }
  catch { return 'latest-ai'; }
}

function saveVersionTarget(target: string): void {
  try { localStorage.setItem(VIEWER_VERSION_TARGET_KEY, target); } catch { /* restricted storage */ }
  window.dispatchEvent(new CustomEvent(VERSION_TARGET_CHANGED_EVENT, { detail: target }));
}

function VersionTargetSelect({ stages, value, onChange, label, rawAvailable }: {
  stages: { id: string; name: string }[];
  value: string;
  onChange: (target: string) => void;
  label: string;
  rawAvailable?: boolean;
}): React.JSX.Element {
  return <label className="version-target-control"><select aria-label={label} title="流程版本" value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="raw" disabled={!rawAvailable}>RAW</option>
    {stages.length ? stages.map((stage) => <option key={stage.id} value={`stage:${stage.id}`}>{stage.name}</option>) : <option value="stage:original">原图</option>}
    {value.startsWith('stage:') && value !== 'stage:original' && !stages.some((stage) => `stage:${stage.id}` === value) && <option value={value}>已选流程（回退）</option>}
    <hr />
    <option value="no-ai">未 AI</option><option value="preferred-ai">首选 AI</option><option value="latest-ai">最新 AI</option>
  </select></label>;
}

function Filmstrip({
  items: sourceItems,
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
  onVisibleIdsChange,
  versionTarget,
  rawCompanions,
  activeGenerationResults,
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
  onVisibleIdsChange: React.Dispatch<React.SetStateAction<string[] | null>>;
  versionTarget?: string | undefined;
  rawCompanions?: Record<string, Photo> | undefined;
  activeGenerationResults?: GenerationResult[] | undefined;
  onOpenContextMenu: (event: React.MouseEvent, photo: Photo, options?: FilmstripMenuOptions) => void;
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 100, scrollLeft: 0 });
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const [previewResults, setPreviewResults] = useState<Record<string, GenerationResult[]>>({});
  const previewPhoto = useCallback((photo: Photo): Photo => {
    if (!versionTarget) return photo;
    if (versionTarget === 'raw' && rawCompanions?.[photo.id]) return rawCompanions[photo.id]!;
    const results = photo.id === selected.id && activeGenerationResults ? activeGenerationResults : previewResults[photo.id] ?? [];
    const { result, member } = resolveViewerVersion(photo, results, versionTarget);
    if (result) return { ...photo, src: result.resultUrl, thumbnailSrc: result.resultUrl };
    return member ? mapCatalogAssets([member.asset])[0]! : photo;
  }, [versionTarget, rawCompanions, activeGenerationResults, selected.id, previewResults]);

  const [viewMode, setViewMode] = useState<'filmstrip' | 'grid'>('filmstrip');
  const [display, setDisplay] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('photoallisai.filmstrip-display') ?? '{}');
      return { flags: saved.flags !== false, ratings: saved.ratings !== false, names: saved.names === true };
    } catch { return { flags: true, ratings: true, names: false }; }
  });
  const changeDisplay = (key: 'flags' | 'ratings' | 'names') => setDisplay((current) => {
    const next = { ...current, [key]: !current[key] };
    try { localStorage.setItem('photoallisai.filmstrip-display', JSON.stringify(next)); } catch { /* restricted storage */ }
    return next;
  });
  const [search, setSearch] = useState('');
  const [minimumRating, setMinimumRating] = useState<number | null>(null);
  const [ratingOperator, setRatingOperator] = useState<'eq' | 'gte' | 'lte'>('gte');
  const [flags, setFlags] = useState<NonNullable<Photo['flag']>[]>([]);
  const [colors, setColors] = useState<NonNullable<Photo['labelColor']>[]>([]);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const filtered = Boolean(search.trim() || minimumRating !== null || flags.length || colors.length || onlyFavorites || favoriteOnly);
  const items = useMemo(() => sourceItems.filter((photo) => (!search.trim() || photo.fileName.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) && (minimumRating === null || (ratingOperator === 'eq' ? photo.rating === minimumRating : ratingOperator === 'lte' ? photo.rating <= minimumRating : photo.rating >= minimumRating)) && (!flags.length || flags.includes(photo.flag ?? 'unflagged')) && (!colors.length || (photo.labelColor && colors.includes(photo.labelColor))) && (!(onlyFavorites || favoriteOnly) || photo.favorite)), [sourceItems, search, minimumRating, ratingOperator, flags, colors, onlyFavorites, favoriteOnly]);
  useEffect(() => {
    const ids = items.map((photo) => photo.id);
    onVisibleIdsChange((current) => current?.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids);
  }, [items, onVisibleIdsChange]);
  const menuOptions: FilmstripMenuOptions = { display, onDisplayChange: changeDisplay, viewMode, onViewModeChange: setViewMode, sortBy, onSortByChange, temporary: Boolean(selected.temporary) };
  const metadataHeight = (display.names ? 20 : 0) + (display.ratings ? 16 : 0);
  const itemSize = 137;
  const layout = useMemo(() => {
    let left = 0;
    const positions = items.map((photo) => {
      const preview = previewPhoto(photo);
      const src = preview.thumbnailSrc ?? preview.src;
      const ratio = ratios[src] ?? IMAGE_ASPECT_RATIOS.get(src) ?? 1.5;
      const width = Math.max(14, Math.max(1, viewport.height - 14 - metadataHeight) * ratio + 14);
      const position = { left, width };
      left += width + 7;
      return position;
    });
    return { positions, totalSize: left };
  }, [items, ratios, viewport.height, metadataHeight, previewPhoto]);
  const firstVisible = layout.positions.findIndex((position) => position.left + position.width >= viewport.scrollLeft - viewport.width);
  const lastVisible = layout.positions.findIndex((position) => position.left > viewport.scrollLeft + viewport.width * 2);
  const virtual = { start: Math.max(0, firstVisible), end: lastVisible < 0 ? items.length : lastVisible, totalSize: layout.totalSize };
  const visibleItems = items.slice(virtual.start, virtual.end);
  const previewAssetKey = JSON.stringify((viewMode === 'grid' ? items : visibleItems).map((photo) => photo.id));
  useEffect(() => {
    if (versionTarget !== 'latest-ai' && versionTarget !== 'preferred-ai') return;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const entries = await Promise.all((JSON.parse(previewAssetKey) as string[]).map(async (id) => [id, await window.desktopApi.listGenerationResults(id)] as const));
        if (active) setPreviewResults((current) => ({ ...current, ...Object.fromEntries(entries) }));
      } catch { /* Keep available previews until the next refresh. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [previewAssetKey, versionTarget]);

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
    const updateWidth = () => {
      const style = getComputedStyle(element);
      setViewport((current) => ({ ...current, width: element.clientWidth, height: Math.max(1, element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) }));
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewMode]);

  useEffect(() => {
    const element = viewportRef.current;
    const index = items.findIndex((photo) => photo.id === selected.id);
    if (!element || index < 0) return;
    if (viewMode === 'filmstrip') {
      const { left, width } = layout.positions[index]!;
      if (left < element.scrollLeft || left + width > element.scrollLeft + element.clientWidth - 20) {
        element.scrollTo({ left: Math.max(0, left - (element.clientWidth - width) / 2), behavior: 'instant' });
      }
    } else {
      window.setTimeout(() => element.querySelector<HTMLElement>(`[data-asset-id="${selected.id}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
    }
  }, [items, selected.id, viewMode, layout, viewport.width]);

  return (
    <section className="filmstrip-region" onContextMenu={(event) => {
      if (event.target instanceof Element && event.target.closest('.viewer-footer')) return;
      event.preventDefault();
      onOpenContextMenu(event, selected, menuOptions);
    }}>
      {toolbarHost && createPortal(<div className="filmstrip-toolbar" onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toolbarHost.closest('.viewer-footer')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: event.clientX, clientY: event.clientY }));
      }}>
        <span className="filmstrip-count" title={filtered ? `${collectionName} · 已加载 ${sourceItems.length} / ${totalCount} 张` : collectionName}>{filtered ? `${items.length} / ${sourceItems.length}` : totalCount} 张</span>
        <PhotoFilterBar compact scope="胶片" search={search} setSearch={setSearch} minimumRating={minimumRating} setMinimumRating={setMinimumRating} ratingOperator={ratingOperator} setRatingOperator={setRatingOperator} flags={flags} setFlags={setFlags} colors={colors} setColors={setColors} onlyFavorites={onlyFavorites} setOnlyFavorites={setOnlyFavorites} favoriteOnly={favoriteOnly} onFavoriteOnlyChange={onFavoriteOnlyChange} temporary={Boolean(selected.temporary)} />
      </div>, toolbarHost)}
      <div className={`filmstrip${viewMode === 'grid' ? ' is-grid' : ''}`} role="listbox" aria-label="照片" aria-multiselectable="true" tabIndex={0} ref={viewportRef} onKeyDown={(event) => {
        const focusIndex = items.findIndex((photo) => photo.id === (selection.focusId ?? selected.id));
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
          event.preventDefault();
          onSelectionChange(selectAll(items.map((photo) => photo.id)));
          return;
        }
        if ((event.metaKey || event.ctrlKey) && event.code === 'Space') {
          event.preventDefault();
          const photo = items[Math.max(0, focusIndex)];
          if (photo) onSelectionChange((current) => updateSelection(current, items.map((item) => item.id), photo.id, 'toggle'));
          return;
        }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || items.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const columns = viewMode === 'grid' ? Math.max(1, Math.floor((viewportRef.current?.clientWidth ?? itemSize) / itemSize)) : 1;
        const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -columns : columns;
        const nextPhoto = items[clamp(focusIndex < 0 ? (delta < 0 ? items.length - 1 : 0) : focusIndex + delta, 0, items.length - 1)]!;
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
        <div className={`filmstrip-track${items.length === 0 ? ' is-empty' : ''}`} style={viewMode === 'grid' ? undefined : { width: items.length === 0 ? '100%' : virtual.totalSize + (hasMore ? itemSize : 0) }}>
        {(viewMode === 'grid' ? items : visibleItems).map((photo, visibleIndex) => {
          const index = viewMode === 'grid' ? visibleIndex : virtual.start + visibleIndex;
          const preview = previewPhoto(photo);
          return (
          <button
            className={`thumb${selected.id === photo.id ? ' is-selected' : ''}${selection.selectedIds.has(photo.id) ? ' is-chosen' : ''}${photo.offline ? ' is-offline' : ''}`}
            key={photo.id}
            data-asset-id={photo.id}
            title={photo.fileName}
            aria-label={photo.fileName}
            data-label-color={photo.labelColor ?? undefined}
            aria-description={photo.labelColor ? `${photoColorName(photo.labelColor)}标签` : undefined}
            style={{ ...(viewMode === 'grid' ? {} : layout.positions[index]), '--thumb-metadata-height': `${metadataHeight}px` } as React.CSSProperties}
            onClick={(event) => onSelect(
              photo,
              event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'replace'
            )}
            onContextMenu={(event) => {
              event.stopPropagation();
              if (event.ctrlKey) {
                event.preventDefault();
                onSelect(photo, event.shiftKey ? 'range' : 'toggle');
                return;
              }
              onOpenContextMenu(event, photo, menuOptions);
            }}
            draggable
            aria-grabbed={selection.selectedIds.has(photo.id)}
            onDragStart={(event) => { preparePhotoDrag(event, photo, selection); }}
            role="option"
            aria-selected={selection.selectedIds.has(photo.id)}
            type="button"
          >
            <span className="raw-placeholder"><Image size={22} /><small>{photo.format}</small></span>
            {preview.thumbnailSrc || preview.src ? <CatalogImage src={preview.thumbnailSrc ?? preview.src} onAspectRatio={(ratio) => { const src = preview.thumbnailSrc ?? preview.src; IMAGE_ASPECT_RATIOS.set(src, ratio); setRatios((current) => current[src] === ratio ? current : { ...current, [src]: ratio }); }} /> : null}
            {photo.status && <i className={`status-dot status-${photo.status}`} />}
            {photo.offline && <i className="offline-badge">离线</i>}
            <span className="thumb-metadata">{display.names && <span className="thumb-name">{photo.fileName}</span>}{display.ratings && <span className="thumb-rating" aria-label={`${photo.rating} 星`}>{Array.from({ length: photo.rating }, (_, index) => <Star size={9} key={index} fill="currentColor" />)}</span>}</span>
            {display.flags && <PhotoFlag photo={photo} />}
          </button>
          );
        })}
        {items.length === 0 && <span className="filmstrip-empty">没有符合条件的照片</span>}
        {hasMore && <button className="filmstrip-more" type="button" style={viewMode === 'grid' ? undefined : { left: layout.totalSize }} onClick={onLoadMore} disabled={loading}>{loading ? '加载中' : '更多'}</button>}
        </div>
      </div>
    </section>
  );
}

function ResultFilmstrip({ results, selectedId, onSelect }: { results: GenerationResult[]; selectedId: string | null | undefined; onSelect: (result: GenerationResult) => void }): React.JSX.Element {
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => { stripRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [selectedId]);
  return <div className="filmstrip result-filmstrip" role="listbox" aria-label="本批 AI 图片" ref={stripRef} tabIndex={0} onKeyDown={(event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const index = results.findIndex((result) => result.id === selectedId);
    const next = results[clamp(index + (event.key === 'ArrowLeft' ? -1 : 1), 0, results.length - 1)];
    if (next) onSelect(next);
  }}>
    {results.map((result) => <button type="button" role="option" aria-selected={result.id === selectedId} aria-label={`${result.fileName} · V${result.version}`} title={result.fileName} data-result-id={result.id} className={`thumb${result.id === selectedId ? ' is-selected is-chosen' : ''}`} key={result.id} onClick={() => onSelect(result)}>
      <CatalogImage src={result.resultUrl} alt={result.fileName} />
      <span className="thumb-index">V{result.version}{result.reviewState === 'preferred' && <Star size={10} fill="currentColor" aria-label="首选" />}</span>
      <span className="thumb-metadata"><span className="thumb-name">{result.fileName.replace(/__ai__v\d+_.+(?=\.[^.]+$)/i, '')}</span></span>
    </button>)}
  </div>;
}

type ViewerOpenOptions = { target?: 'latest-ai'; resultId?: string | undefined; results?: GenerationResult[] };
type OpenTaskViewer = (assetId: string, assetIds?: string[], options?: ViewerOpenOptions) => void;

function taskGenerationResults(tasks: PersistedTask[]): GenerationResult[] {
  return tasks.flatMap((task) => {
    const parsed = generationResultSchema.safeParse(task.result?.generation);
    return task.kind === 'generation' && parsed.success ? [parsed.data] : [];
  });
}

function Viewer({
  photo,
  results,
  isDemo,
  trackedExportNotice,
  onReview,
  onOpenContextMenu,
  onClose,
  initialResultId,
  initialVersionTarget,
  onVersionTargetChange,
  resultsLoading = false,
  resultSequence,
  rawCompanion,
  onToolbarHostChange,
  onWorkflowStageChange
}: {
  photo: Photo;
  results: GenerationResult[];
  isDemo: boolean;
  trackedExportNotice: string;
  onReview: (resultId: string, reviewState: GenerationResult['reviewState']) => Promise<void>;
  onOpenContextMenu: (event: React.MouseEvent, resultId: string | null) => void;
  onClose?: (() => void) | undefined;
  initialResultId?: string | null | undefined;
  initialVersionTarget?: string | undefined;
  onVersionTargetChange?: ((target: string) => void) | undefined;
  resultsLoading?: boolean;
  resultSequence?: GenerationResult[] | undefined;
  rawCompanion?: Photo | null | undefined;
  onToolbarHostChange: (element: HTMLDivElement | null) => void;
  onWorkflowStageChange?: ((photo: Photo) => void) | undefined;
}): React.JSX.Element {
  const [versionTarget, setVersionTarget] = useState<string>(() => {
    if (initialVersionTarget) return initialVersionTarget;
    return readVersionTarget();
  });
  useEffect(() => { onVersionTargetChange?.(versionTarget); }, [versionTarget, onVersionTargetChange]);
  const manualStagePhotoId = useRef<string | null>(null);
  const [targetRevision, setTargetRevision] = useState(0);
  const changeVersionTarget = (target: string) => {
    manualStagePhotoId.current = null;
    setVersionTarget(target);
    saveVersionTarget(target);
    setTargetRevision((revision) => revision + 1);
  };
  const [compareMode, setCompareMode] = useState<CompareMode>('single');
  const [split, setSplit] = useState(52);
  const [showOriginal, setShowOriginal] = useState(false);
  const [holdPreviousVersion, setHoldPreviousVersion] = useState(false);
  const [selectedResultId, setSelectedResultId] = useState<string | null>(results[0]?.id ?? null);
  const [zoom, setZoom] = useState(1);
  const rememberedZoomRef = useRef(Number(localStorage.getItem('photoallisai.viewer-double-click-percent')) || 100);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panOriginRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const wheelEndTimerRef = useRef<number | undefined>(undefined);
  const [imageAspectRatio, setImageAspectRatio] = useState(() => photo.src ? IMAGE_ASPECT_RATIOS.get(photo.src) ?? 3 / 2 : 3 / 2);
  const [fittedSize, setFittedSize] = useState({ width: 0, height: 0 });
  const [naturalWidth, setNaturalWidth] = useState(0);
  const [background, setBackground] = useState<'neutral' | 'checker' | 'light' | 'dark'>(() => {
    const saved = localStorage.getItem('photoallisai.viewer-background');
    return saved === 'checker' || saved === 'light' || saved === 'dark' ? saved : 'neutral';
  });
  const [fitMode, setFitMode] = useState<'fit' | 'actual' | 'width' | 'custom'>('fit');
  const [viewerNotice, setViewerNotice] = useTransientNotice();
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const { stages: workflowStages, result: targetResult, member: targetMember, rawMember } = resolveViewerVersion(photo, results, versionTarget);
  const availableRaw = rawMember ? mapCatalogAssets([rawMember.asset])[0] : isRawPhoto(photo) ? photo : rawCompanion;
  const explicitResult = initialResultId !== undefined && targetRevision === 0;
  const initialSelectionId = explicitResult
    ? results.find((result) => result.id === initialResultId)?.id ?? null
    : targetResult?.id ?? null;
  const targetPhotoId = explicitResult || resultsLoading ? null : versionTarget === 'raw' && !rawMember ? null : targetMember?.asset.id ?? null;
  const effectiveSelectionId = targetPhotoId && targetPhotoId !== photo.id ? null : initialSelectionId;
  useEffect(() => {
    if (!targetPhotoId || targetPhotoId === photo.id || !photo.workflow || manualStagePhotoId.current === photo.id) return;
    const member = photo.workflow.members.find((item) => item.asset.id === targetPhotoId);
    if (member) onWorkflowStageChange?.({ ...mapCatalogAssets([member.asset])[0]!, workflow: photo.workflow });
  }, [targetPhotoId, photo.id, photo.workflow, onWorkflowStageChange, targetRevision]);
  const selectedResult = selectedResultId ? results.find((result) => result.id === selectedResultId) : undefined;
  const resultIndex = resultSequence?.findIndex((result) => result.id === selectedResultId) ?? -1;
  const resultPosition = resultIndex >= 0 ? `${resultIndex + 1}/${resultSequence!.length}` : undefined;
  const generatedSource = isDemo ? photo.src : selectedResult?.resultUrl;
  const [displayedGeneratedSource, setDisplayedGeneratedSource] = useState(generatedSource);
  useEffect(() => {
    if (resultsLoading && !isDemo) return;
    if (generatedSource) {
      setDisplayedGeneratedSource(generatedSource);
      return;
    }
    // Keep the outgoing AI image until the incoming base image can be displayed.
    let active = true;
    const image = new window.Image();
    image.src = photo.originalSrc ?? photo.src;
    void image.decode().catch(() => undefined).then(() => { if (active) setDisplayedGeneratedSource(undefined); });
    return () => { active = false; };
  }, [generatedSource, resultsLoading, isDemo, photo.originalSrc, photo.src]);
  const originalStage = workflowStages[0];
  const originalMember = originalStage ? photo.workflow?.members.find((member) => member.stageId === originalStage.id && !member.asset.offline && !isRawPhoto(member.asset)) ?? photo.workflow?.members.find((member) => member.stageId === originalStage.id && !member.asset.offline) : undefined;
  const originalPhoto = (originalMember ? mapCatalogAssets([originalMember.asset])[0] : undefined) ?? photo;
  const showingOriginal = !generatedSource && versionTarget !== 'raw' && originalPhoto.id === photo.id;
  const comparisonPhoto = versionTarget === 'raw' ? originalPhoto
    : showingOriginal ? availableRaw
      : originalPhoto;
  const rawBase = versionTarget === 'raw' && !rawMember && availableRaw ? availableRaw : photo;
  const baseSource = holdPreviousVersion && comparisonPhoto ? comparisonPhoto.originalSrc ?? comparisonPhoto.src : rawBase.originalSrc ?? rawBase.src;
  const activeSource = displayedGeneratedSource && !showOriginal && !holdPreviousVersion ? displayedGeneratedSource : baseSource;
  const sourceSizes = useRef(new Map<string, { width: number; height: number }>());
  const canCompare = Boolean(generatedSource);
  const pixelZoom = actualPixelZoom(naturalWidth, fittedSize.width, window.devicePixelRatio);
  const maxZoom = Math.max(8, pixelZoom * 8);
  const minZoom = Math.min(.05, pixelZoom / 10);
  const zoomPercent = naturalWidth && fittedSize.width ? Math.round(zoom / pixelZoom * 100) : 100;
  useEffect(() => {
    if (fitMode === 'fit' || zoom <= 1.001 || !naturalWidth || !fittedSize.width) return;
    const percent = zoom / pixelZoom * 100;
    rememberedZoomRef.current = percent;
    localStorage.setItem('photoallisai.viewer-double-click-percent', String(percent));
  }, [zoom, pixelZoom, naturalWidth, fittedSize.width, fitMode]);
  const setViewMode = useCallback((mode: 'fit' | 'actual' | 'width') => {
    setFitMode(mode);
    setPan({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    if (fitMode === 'fit') setZoom(1);
    else if (fitMode === 'actual') setZoom(pixelZoom);
    else if (fitMode === 'width') setZoom(canvasWrapRef.current ? canvasWrapRef.current.clientWidth / Math.max(1, fittedSize.width) : 1);
  }, [fitMode, fittedSize.width, fittedSize.height, pixelZoom]);

  useLayoutEffect(() => {
    setSelectedResultId(effectiveSelectionId);
    setZoom(1);
    setFitMode('fit');
    setPan({ x: 0, y: 0 });
  }, [photo.id, photo.src, effectiveSelectionId]);

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
      if (event.code === 'Space' && event.type === 'keyup') {
        setHoldPreviousVersion(false);
        return;
      }
      const target = event.target;
      if (!(target instanceof Element) || target.closest('input, textarea, select, [contenteditable="true"]') || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === 'Space') {
        event.preventDefault();
        setHoldPreviousVersion(true);
      }
      if (event.key.toLowerCase() === 'o') setShowOriginal(event.type === 'keydown');
    };
    const restore = () => setHoldPreviousVersion(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', restore);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', restore);
    };
  }, []);

  useEffect(() => {
    const onMenuCommand = (event: Event) => {
      const command = (event as CustomEvent<MenuCommand>).detail;
      if (command === 'fit-image') setViewMode('fit');
      else if (command === 'zoom-100') setViewMode('actual');
      else if (command === 'toggle-original') {
        setShowOriginal((current) => !current);
      }
    };
    window.addEventListener('photoallisai:menu-command', onMenuCommand);
    return () => window.removeEventListener('photoallisai:menu-command', onMenuCommand);
  }, [setViewMode]);

  useEffect(() => () => {
    if (wheelEndTimerRef.current !== undefined) window.clearTimeout(wheelEndTimerRef.current);
  }, []);

  const adjustZoom = (factor: number) => {
    setFitMode('custom');
    setZoom((current) => {
      const next = clamp(current * factor, minZoom, maxZoom);
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };
  const constrainPan = useCallback((nextPan: { x: number; y: number }, nextZoom: number) => {
    const container = canvasWrapRef.current;
    if (!container || nextZoom <= 1) return { x: 0, y: 0 };
    return boundPan(nextPan, nextZoom, fittedSize, { width: container.clientWidth, height: container.clientHeight });
  }, [fittedSize]);
  const captureAspectRatio = (source: string, image: HTMLImageElement) => {
    if (image.src !== new URL(source, window.location.href).href) return;
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      sourceSizes.current.set(source, { width: image.naturalWidth, height: image.naturalHeight });
      if (source === activeSource) {
        const ratio = image.naturalWidth / image.naturalHeight;
        setImageAspectRatio(ratio);
        setNaturalWidth(image.naturalWidth);
        const container = canvasWrapRef.current;
        if (container) {
          const availableWidth = Math.max(1, container.clientWidth);
          const availableHeight = Math.max(1, container.clientHeight);
          const width = Math.min(availableWidth, availableHeight * ratio);
          setFittedSize({ width, height: width / ratio });
        }
      }
    }
  };

  return (
    <section className="viewer" data-label-color={photo.labelColor ?? undefined}>

      <div className={`canvas-wrap background-${background}${zoom > 1 ? ' is-zoomed' : ''}`} tabIndex={0} ref={canvasWrapRef} onContextMenu={(event) => onOpenContextMenu(event, selectedResult?.id ?? null)} onWheel={(event) => {
        const container = event.currentTarget;
        container.classList.add('is-gesturing');
        if (wheelEndTimerRef.current !== undefined) window.clearTimeout(wheelEndTimerRef.current);
        wheelEndTimerRef.current = window.setTimeout(() => container.classList.remove('is-gesturing'), 90);
        if (event.ctrlKey || event.metaKey || event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
          event.preventDefault();
          const rect = container.getBoundingClientRect();
          const pointer = { x: event.clientX - (rect.left + rect.width / 2), y: event.clientY - (rect.top + rect.height / 2) };
          const normalizedDelta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 80 : 1);
          setFitMode('custom');
          setZoom((current) => {
            const next = clamp(current * Math.exp(-normalizedDelta * 0.0025), minZoom, maxZoom);
            setPan((currentPan) => constrainPan(zoomAround(currentPan, pointer, current, next), next));
            return next;
          });
        } else if (zoom > 1) {
          event.preventDefault();
          setPan((current) => constrainPan({ x: current.x - event.deltaX, y: current.y - event.deltaY }, zoom));
        }
      }} onDoubleClick={(event) => {
            if (event.target instanceof Element && event.target.closest('input, button')) return;
            if (zoom > 1.001) { setViewMode('fit'); return; }
            const rect = canvasWrapRef.current!.getBoundingClientRect();
            const pointer = { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
            const next = clamp(Math.max(1.5, rememberedZoomRef.current / 100 * pixelZoom), minZoom, maxZoom);
            setFitMode('custom');
            setPan(zoomAround(pan, pointer, zoom, next));
            setZoom(next);
          }} onPointerDown={(event) => {
        if (event.target instanceof Element && event.target.closest('button, input, select, [role="slider"]')) return;
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
          <PhotoFlag photo={photo} />
        </div>
        {!isDemo && <div className="viewer-target-version" title="目标版本：优先显示所选版本，不存在时逐级回退">
          <VersionTargetSelect stages={workflowStages} value={versionTarget} onChange={changeVersionTarget} label="切换目标版本" rawAvailable={Boolean(availableRaw)} />
        </div>}
        <div
          className={`photo-canvas${canCompare && compareMode === 'split' ? ' is-comparing' : ''}`}
          style={{ width: fittedSize.width, height: fittedSize.height, visibility: fittedSize.height > 0 ? 'visible' : 'hidden', transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}

        >
          <div className="preview-unavailable"><Image size={36} /><strong>预览暂不可用</strong><span>图像服务将在后台生成屏幕预览</span></div>
          {baseSource ? <BufferedPreviewImage className="base-image" src={baseSource} alt={photo.fileName} onReady={(image) => captureAspectRatio(baseSource, image)} /> : null}
          {displayedGeneratedSource && !showOriginal && !holdPreviousVersion && (
            <div
              className="generated-layer"
              style={compareMode === 'split' ? { clipPath: `inset(0 ${100 - split}% 0 0)` } : undefined}
            >
              <BufferedPreviewImage className="generated-image" src={displayedGeneratedSource} alt="AI 生成版本" onReady={(image) => captureAspectRatio(displayedGeneratedSource, image)} />
            </div>
          )}
          {canCompare && compareMode === 'split' && !holdPreviousVersion && (
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
      {selectedResult && !isDemo && <div className="viewer-review-overlay" role="group" aria-label="当前版本审阅" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" title="接受当前版本" aria-label="接受当前版本" aria-pressed={selectedResult.reviewState === 'accepted'} onClick={() => void onReview(selectedResult.id, 'accepted')}><Check size={15} /></button>
        <button type="button" title="标记为首选" aria-label="标记为首选" aria-pressed={selectedResult.reviewState === 'preferred'} onClick={() => void onReview(selectedResult.id, 'preferred')}><Star size={15} fill={selectedResult.reviewState === 'preferred' ? 'currentColor' : 'none'} /></button>
        <button type="button" title="拒绝当前版本" aria-label="拒绝当前版本" aria-pressed={selectedResult.reviewState === 'rejected'} onClick={() => void onReview(selectedResult.id, 'rejected')}><X size={15} /></button>
      </div>}
      {(trackedExportNotice || viewerNotice) && <span className="viewer-operation-notice" role="status">{trackedExportNotice || viewerNotice}</span>}
      </div>
      <ViewerToolbar>
        {(results.length > 0 || isDemo) && <div className="viewer-actions" data-tool-group="compare">
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
              disabled={!canCompare}
              onClick={() => setCompareMode('split')}
              type="button"
            >
              <Columns2 size={13} /> 对比
            </button>
          </div>
        </div>}
        <div className="viewer-actions" data-tool-group="zoom">
          <IconButton label="缩小" disabled={zoom <= minZoom} onClick={() => adjustZoom(0.8)}><ZoomOut size={15} /></IconButton>
          <ViewerZoomControl percent={zoomPercent} title={photo.originalSrc || selectedResult ? '缩放比例：100% 为实际像素' : '当前为解码预览，100% 按预览像素计算'} onZoom={(percent) => {
            setFitMode('custom');
            setZoom(Math.max(minZoom, Math.min(maxZoom, percent / 100 * pixelZoom)));
            setPan({ x: 0, y: 0 });
          }} onCommand={(value) => {
            if (value === 'fit') setViewMode('fit');
            else if (value === 'width') setViewMode('width');
            else if (value === 'fullscreen') {
              const operation = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
              void operation.catch(() => setViewerNotice('无法切换全屏，请使用系统窗口的全屏按钮'));
            } else if (value.startsWith('background:')) {
              const next = value.slice(11) as typeof background;
              setBackground(next);
              localStorage.setItem('photoallisai.viewer-background', next);
            }
          }} />
          <IconButton label="放大" disabled={zoom >= maxZoom} onClick={() => adjustZoom(1.25)}><ZoomIn size={15} /></IconButton>
          <IconButton label="适应窗口" active={fitMode === 'fit'} pressed={fitMode === 'fit'} onClick={() => setViewMode('fit')}><Maximize2 size={15} /></IconButton>
        </div>
        <div className="version-switcher" data-tool-group="versions">
          {!!resultSequence?.length && <span className="viewer-result-position" style={{ visibility: resultPosition ? 'visible' : 'hidden' }} aria-hidden={!resultPosition}>AI 结果 · {resultPosition ?? `1/${resultSequence.length}`}</span>}
          {availableRaw && <button className={!selectedResult && versionTarget === 'raw' ? 'is-current' : ''} type="button" onClick={() => changeVersionTarget('raw')}>RAW</button>}
          {photo.workflow && <select aria-label="流程阶段" title="按规则关联" value={photo.id} onChange={(event) => {
            const member = photo.workflow!.members.find((item) => item.asset.id === event.target.value);
            if (member) { manualStagePhotoId.current = member.asset.id; onWorkflowStageChange?.({ ...mapCatalogAssets([member.asset])[0]!, workflow: photo.workflow! }); }
          }}>{photo.workflow.members.map((member, index) => <option key={member.asset.id} value={member.asset.id}>{member.stageName}{member.variant ? ` · ${member.variant}` : photo.workflow!.members.filter((item) => item.stageId === member.stageId).length > 1 ? ` · ${index + 1}` : ''} — {member.asset.fileName}{member.asset.offline ? '（离线）' : ''}</option>)}</select>}
          <button className={!selectedResult && versionTarget !== 'raw' && !isDemo ? 'is-current' : ''} type="button" title="按住 O 键可临时查看当前文件" onClick={() => { if (versionTarget === 'raw') changeVersionTarget('stage:original'); else setSelectedResultId(null); }}>{photo.workflow ? '当前文件' : '原图'}</button>
          {isDemo ? <><button type="button">V1</button><button className="is-current" type="button">V2</button></> : [...results].reverse().map((result) => (
            <button className={`version-button${selectedResult?.id === result.id ? ' is-current' : ''}${result.reviewState === 'preferred' ? ' is-preferred' : result.reviewState === 'rejected' ? ' is-rejected' : ''}`} type="button" key={result.id} onClick={() => setSelectedResultId(result.id)} title={result.reviewState === 'preferred' ? '首选' : result.reviewState === 'accepted' ? '已接受' : result.reviewState === 'rejected' ? '已拒绝' : '未审阅'}>V{result.version}</button>
          ))}
        </div>
        <div className="viewer-library-tools" data-tool-group="library" ref={onToolbarHostChange} />
      </ViewerToolbar>
    </section>
  );
}

function AiPanel({
  photo,
  revision,
  isDemo,
  notice,
  onAnalyze,
  analyzing,
  analysisTaskStatus,
  analysisErrorCode,
  onAddToWorkflow,
  onOpenBatch,
  workflowQueueCount,
  workflowPosition,
  selectionCount
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
  const [analysisDetailsOpen, setAnalysisDetailsOpen] = useState(() => {
    try { return localStorage.getItem(ANALYSIS_DETAILS_OPEN_KEY) === 'true'; } catch { return false; }
  });
  const analysisQueued = analysisTaskStatus === 'queued' || analysisTaskStatus === 'paused';
  const analysisRunning = analysisTaskStatus !== undefined && ['preparing', 'uploading', 'processing', 'downloading', 'saving'].includes(analysisTaskStatus);
  const analysisSyncing = analysisTaskStatus === 'completed' && !result;
  const analysisPending = analysisQueued || analysisRunning || analysisSyncing;
  const score = isDemo ? 86 : result ? Math.round(result.quality.overallScore) : '--';
  const scoreLevel = typeof score !== 'number' ? undefined : score >= 85 ? 'excellent' : score >= 70 ? 'good' : score >= 50 ? 'fair' : 'poor';
  const scoreHint = scoreLevel === 'excellent' ? '优秀 · 85–100 分' : scoreLevel === 'good' ? '良好 · 70–84 分' : scoreLevel === 'fair' ? '一般 · 50–69 分' : scoreLevel === 'poor' ? '需改善 · 0–49 分' : '尚无评分';
  const summary = isDemo ? '自然光人像' : result?.summary ?? (analysisRunning ? '正在视觉分析' : analysisQueued ? '已加入分析队列' : analysisSyncing ? '正在载入分析结果' : analysisTaskStatus === 'failed' ? '视觉分析失败' : '等待视觉分析');

  return (
    <div className="ai-panel-content">
        <header className="ai-selection-scope"><strong>{selectionCount > 1 ? `${selectionCount} 张图片` : photo.fileName}</strong></header>
        <section className="ai-purpose-card" aria-label="视觉分析">
        {selectionCount > 1 && <p className="ai-current-preview">当前查看：{photo.fileName}</p>}
        <div className="analysis-head">
          <div className="analysis-meta">
          <div className="analysis-score" data-level={scoreLevel}><span>AI 评分</span><strong title={scoreHint} aria-label={`AI 评分：${score}，${scoreHint}`}>{score}</strong></div>
          <IconButton label={analyzing ? '正在提交' : selectionCount > 1 ? `分析选中的 ${selectionCount} 张` : analysisRunning ? '正在分析' : analysisQueued ? '等待分析' : analysisSyncing ? '正在同步' : isDemo || result ? '重新分析本图' : '分析本图'} onClick={onAnalyze} disabled={isDemo || analyzing || (selectionCount === 1 && analysisPending)}><RefreshCw size={14} className={analyzing || analysisRunning || analysisSyncing ? 'is-spinning' : undefined} /></IconButton>
          </div>
          <div className="analysis-head-content"><strong>{summary}</strong></div>
          {!isDemo && notice && <p className="analysis-notice" aria-live="polite">{notice}</p>}
          {!isDemo && analysisTaskStatus === 'failed' && <AnalysisFailure code={analysisErrorCode} />}
        </div>

        {(isDemo || result) && <details className="analysis-details" open={analysisDetailsOpen} onToggle={(event) => {
          const open = event.currentTarget.open;
          setAnalysisDetailsOpen(open);
          try { localStorage.setItem(ANALYSIS_DETAILS_OPEN_KEY, String(open)); } catch { /* storage may be unavailable */ }
        }}>
          <summary><ChevronRight size={14} /><span>详细分析</span></summary>
          <div className="analysis-details-content">
          <p className="analysis-copy">{isDemo ? '柔和侧光塑造了自然肤色。建议保留浅景深和发丝细节，同时清理右后方路人并轻微提亮面部。' : result?.report}</p>
          {isDemo ? <><div className="issue-row"><i className="severity high" /><span>背景路人分散注意力</span><em>严重</em></div><div className="issue-row"><i className="severity medium" /><span>面部中间调略暗</span><em>中等</em></div></> : result?.quality.issues.map((issue) => <div className="issue-row" key={`${issue.type}-${issue.description}`}><i className={`severity ${issue.severity >= 0.7 ? 'high' : 'medium'}`} /><span>{issue.description}</span><em title="识别置信度">{Math.round(issue.confidence * 100)}%</em></div>)}
          </div>
        </details>}
        </section>
        <section className="ai-purpose-card ai-batch-destination" aria-label="批量修图">
          <header className="ai-purpose-heading"><Image size={15} /><strong>批量修图</strong><span>{workflowQueueCount} 张图片</span><IconButton label="打开批量修图" onClick={onOpenBatch}><ChevronRight size={14} /></IconButton></header>
          {workflowPosition !== null && selectionCount <= 1
            ? <button className="secondary-action compact is-queued" type="button" onClick={onOpenBatch}><Check size={14} />已加入修图列表<ChevronRight size={13} /></button>
            : <button className="secondary-action compact" type="button" onClick={onAddToWorkflow}><Plus size={14} />{selectionCount > 1 ? `添加选中的 ${selectionCount} 张到批量修图` : '添加到批量修图'}</button>}
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
  onWorkflowTemplateChange
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
    if (isDemo || !photo || photo.temporary) {
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
    return <div className="ai-panel-content"><section className="ai-purpose-card"><p className="ai-empty-selection">未选择图片</p></section><section className="ai-purpose-card ai-batch-destination"><header className="ai-purpose-heading"><Image size={15} /><strong>批量修图</strong><span>{workflowAssetIds.length} 张图片</span><IconButton label="打开批量修图" onClick={onOpenBatch}><ChevronRight size={14} /></IconButton></header></section></div>;
  }

  if (photo.temporary) return <div className="ai-panel-content"><section className="ai-purpose-card"><button className="secondary-action" type="button" disabled={analyzing} onClick={() => {
    setAnalyzing(true);
    void window.desktopApi.linkImageDirectory(photo.id).then(() => setNotice('已关联所在文件夹，可在图库中选择图片进行分析与批量修图。')).catch((error: unknown) => setNotice(error instanceof Error ? error.message : '关联失败')).finally(() => setAnalyzing(false));
  }}><FolderInput size={14} />关联所在文件夹</button>{notice && <p role="status">{notice}</p>}</section></div>;

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

function InspectorInfo({ photo, revision }: { photo: Photo; revision: AnalysisRevision | undefined }): React.JSX.Element {
  const [details, setDetails] = useState<{ id: string; data?: FileDetails; error?: string }>({ id: photo.id });
  const [dimensions, setDimensions] = useState<{ id: string; width: number; height: number } | null>(null);
  useEffect(() => {
    let active = true;
    void window.desktopApi.getFileDetails(photo.id).then((data) => { if (active) setDetails({ id: photo.id, data }); }, (error: unknown) => { if (active) setDetails({ id: photo.id, error: error instanceof Error ? error.message : '文件信息不可用' }); });
    const image = new window.Image();
    image.onload = () => { if (active) setDimensions({ id: photo.id, width: image.naturalWidth, height: image.naturalHeight }); };
    image.src = photo.originalSrc ?? photo.src;
    return () => { active = false; image.onload = null; };
  }, [photo.id, photo.originalSrc, photo.src]);
  const data = details.id === photo.id ? details.data : undefined;
  const size = dimensions?.id === photo.id ? `${dimensions.width} × ${dimensions.height}` : data?.width && data.height ? `${data.width} × ${data.height}` : '—';
  const fields = [
    ['文件名', photo.fileName],
    ['格式', photo.format],
    [photo.originalSrc ? '尺寸' : '预览尺寸', size],
    ...(data ? [['文件大小', formatStorageBytes(data.sizeBytes)], ['修改时间', new Date(data.modifiedAt).toLocaleString()], ['位置', data.path]] : []),
    ['评分', `${photo.rating} / 5`],
    ...(revision ? [['AI 状态', '已分析']] : [])
  ];
  const shooting = data ? [['相机', data.camera], ['镜头', data.lens], ['拍摄时间', data.takenAt ? new Date(data.takenAt).toLocaleString() : undefined], ['快门', data.exposure], ['光圈', data.aperture ? `f/${data.aperture}` : undefined], ['ISO', data.iso?.toString()], ['焦距', data.focalLength ? `${data.focalLength} mm` : undefined]].filter(([, value]) => value) : [];
  return <div className="inspector-info"><section className="inspector-section"><div className="inspector-heading"><span>文件信息</span>{data && <IconButton label="复制文件路径" onClick={() => { void navigator.clipboard.writeText(data.path).catch(() => window.dispatchEvent(new CustomEvent(OPERATION_NOTICE_EVENT, { detail: '无法复制文件路径，请检查剪贴板权限' }))); }}><Copy size={13} /></IconButton>}</div><div className="metadata-list">{fields.map(([label, value]) => <div key={label}><span>{label}</span><strong title={value}>{value}</strong></div>)}</div>{details.id === photo.id && details.error && !E2E_DEMO_MODE && <p className="inline-error">{details.error}</p>}</section>{shooting.length > 0 && <details className="inspector-section metadata-shooting"><summary>拍摄信息</summary><div className="metadata-list">{shooting.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></details>}<section className="inspector-section"><div className="inspector-heading"><span>用户标签</span><span className="section-count">{photo.tags?.length ?? 0} 个</span></div>{photo.tags?.length ? <div className="metadata-tags">{photo.tags.map((tag) => <span key={tag.id}>{tag.name}</span>)}</div> : <div className="inline-empty">尚未添加标签</div>}</section>{revision && <section className="inspector-section"><div className="inspector-heading"><span>AI 编目</span></div><p className="analysis-copy">{revision.result.catalog.shortDescription}</p></section>}</div>;
}

function GlobalDetailsPanel({ photo }: { photo: Photo }): React.JSX.Element {
  const [state, setState] = useState<{ id: string; revision?: AnalysisRevision | undefined; results: GenerationResult[]; trashed: TrashedGenerationResult[]; error?: string }>({ id: photo.id, results: [], trashed: [] });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    if (photo.temporary) return;
    const load = () => {
      void Promise.all([window.desktopApi.listAnalysisRevisions(photo.id), window.desktopApi.listGenerationResults(photo.id), window.desktopApi.listTrashedGenerationResults(photo.id)])
        .then(([revisions, results, trashed]) => { if (active) setState({ id: photo.id, revision: revisions[0], results, trashed }); })
        .catch((error: unknown) => { if (active) setState({ id: photo.id, results: [], trashed: [], error: error instanceof Error ? error.message : '无法读取版本' }); });
    };
    load();
    const timer = window.setInterval(load, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [photo.id, photo.temporary, refresh]);
  const current = state.id === photo.id && !photo.temporary ? state : undefined;
  return <div className="inspector-details"><InspectorInfo photo={photo} revision={current?.revision} />{current?.error && <p className="inline-error">{current.error}</p>}{current && (current.results.length > 0 || current.trashed.length > 0) && <InspectorVersions results={current.results} trashedResults={current.trashed} onTrashResult={async (id) => { await window.desktopApi.trashGenerationResult({ resultId: id }); setRefresh((value) => value + 1); }} onRestoreResult={async (id) => { await window.desktopApi.restoreGenerationResult({ resultId: id }); setRefresh((value) => value + 1); }} />}</div>;
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
  }, [task.id, task.kind, task.status, task.assetId, task.createdAt, task.updatedAt, task.payload.providerProfileId, task.result]);
  if (task.kind !== 'analysis' || task.status !== 'completed') return null;
  const result = parsed.success ? parsed.data : legacyResult;
  if (!result) return <div className="task-analysis-result">本次任务未保存可查看的分析结果</div>;
  return <details className="task-analysis-result"><summary><strong>{result.summary}</strong><span>{Math.round(result.quality.overallScore)} 分</span></summary><div className="task-analysis-report"><p>{result.report}</p><p>{result.catalog.longDescription}</p><div className="metadata-tags">{result.catalog.keywords.map((tag) => <span key={tag}>{tag}</span>)}</div>{result.quality.issues.map((issue, index) => <p key={index}>{issue.description}</p>)}{result.adjustments.global.map((item, index) => <p key={`adjust-${index}`}>{item.parameter} {item.value} {item.unit} · {item.reason}</p>)}{result.generativeActions.map((item) => <p key={item.id}>{item.target}：{item.instruction}</p>)}</div></details>;
}

function TaskOutput({ task, photos, batchTasks, onOpenViewer }: { task: PersistedTask; photos: Photo[]; batchTasks: PersistedTask[]; onOpenViewer?: OpenTaskViewer | undefined }): React.JSX.Element | null {
  if (task.kind === 'generation') {
    const generated = generationResultSchema.safeParse(task.result?.generation);
    return <details className="task-analysis-result"><summary>生成详情</summary><div className="task-analysis-report">{generated.success && <figure className="task-generated-result" data-label-color={photos.find((photo) => photo.id === task.assetId)?.labelColor ?? undefined}><button type="button" aria-label={`查看生成图片 ${generated.data.fileName}`} onClick={() => onOpenViewer?.(generated.data.assetId, [...new Set(batchTasks.flatMap((item) => item.assetId ? [item.assetId] : []))], { resultId: generated.data.id, results: taskGenerationResults(batchTasks) })}><img src={generated.data.resultUrl} alt={generated.data.fileName} loading="lazy" /></button><figcaption>{generated.data.fileName}</figcaption></figure>}<p className="task-prompt-text">{typeof task.payload.prompt === 'string' ? task.payload.prompt : '未保存提示词'}</p></div></details>;
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

function useAssetPhotos(assetIds: string[], providedPhotos: Photo[]): Photo[] {
  const [resolved, setResolved] = useState<Photo[]>([]);
  const [revision, setRevision] = useState(0);
  useEffect(() => window.desktopApi.onCatalogChanged(() => setRevision((current) => current + 1)), []);
  const missingIds = [...new Set(assetIds)]
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
  }, [missingKey, revision]);
  return [...providedPhotos, ...resolved.filter((photo) => !providedPhotos.some((item) => item.id === photo.id))];
}

function useTaskPhotos(tasks: PersistedTask[], providedPhotos: Photo[]): Photo[] {
  return useAssetPhotos(tasks.flatMap((task) => task.assetId ? [task.assetId] : []), providedPhotos);
}

function TaskBatchGroup({ tasks, photos: providedPhotos, children, onOpenViewer: openViewer, expanded = false, expandRequest = 0, compact = false }: { tasks: PersistedTask[]; photos: Photo[]; children?: React.ReactNode; onOpenViewer?: OpenTaskViewer; expanded?: boolean; expandRequest?: number; compact?: boolean }): React.JSX.Element {
  const photos = useTaskPhotos(tasks, providedPhotos);
  const onOpenViewer = useMemo(() => openViewer ? (assetId: string) => openViewer(assetId, tasks.flatMap((task) => task.assetId ? [task.assetId] : []), { target: 'latest-ai' }) : undefined, [openViewer, tasks]);
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
  const assetCount = new Set(tasks.map((task) => task.assetId).filter((id): id is string => Boolean(id))).size;
  const firstPhoto = photos.find((photo) => photo.id === first.assetId);
  const title = first.kind === 'generation'
    ? `生成: ${firstPhoto?.relativePath ?? taskImageName(first, photos)}${assetCount > 1 ? ` 等 ${assetCount} 张图片` : ''}`
    : taskLabels[first.kind];
  const startedAt = Math.min(...tasks.map((task) => task.createdAt));
  const lastUpdatedAt = Math.max(...tasks.map((task) => task.updatedAt));
  const batchPhoto = first.kind === 'generation' ? photos.find((photo) => photo.id === first.assetId) : undefined;
  const batchIcon = batchPhoto?.thumbnailSrc || batchPhoto?.src
    ? <span className="task-batch-image"><img src={batchPhoto.thumbnailSrc || batchPhoto.src} alt="" />{assetCount > 1 && <b>{assetCount}</b>}</span>
    : <TaskKindIcon kind={first.kind} />;
  const summary = <><ChevronRight size={14} />{batchIcon}<span className="task-batch-heading"><span className="task-batch-title-row"><strong>{title}</strong><small className="task-batch-time">{formatTaskTime(startedAt)}（用时 {formatTaskDuration(startedAt, stats.active + stats.queued + stats.paused > 0 ? Date.now() : lastUpdatedAt)}）</small></span><small>{first.kind === 'generation' ? `${assetCount || 1} 张图片 · ${stats.total} 个版本` : `${taskImageName(first, photos)}${tasks.length > 1 ? ` 等 ${stats.total} 项` : ` · ${stats.total} 项`}`}</small></span><span className="task-batch-counts"><span>成功 {stats.completed}</span>{(!compact || stats.active > 0) && <span>处理中 {stats.active}</span>}{(!compact || stats.queued > 0) && <span>等待 {stats.queued}</span>}{stats.paused > 0 && <span>暂停 {stats.paused}</span>}{(!compact || stats.failed > 0) && <span className={stats.failed > 0 ? 'failed-count' : ''}>失败 {stats.failed}</span>}{stats.canceled > 0 && <span>取消 {stats.canceled}</span>}</span><progress aria-label="批次进度" max={Math.max(stats.total, 1)} value={stats.settled} /></>;
  return <details ref={detailRef} className={`task-batch-group${compact ? ' is-compact' : ''}`}><summary className="task-batch-summary" data-task-batch={first.id}>{summary}<TaskBatchButtons tasks={tasks} /></summary><div className="task-batch-members">{children ?? tasks.map((task) => { const photo = photos.find((item) => item.id === task.assetId); return <div className="task-batch-member" key={task.id}><div className="task-row task-activity-row" data-task-id={task.id}><button className="task-member-preview" data-label-color={photo?.labelColor ?? undefined} type="button" disabled={!photo || !onOpenViewer} onClick={() => { if (photo && onOpenViewer) onOpenViewer(photo.id); }} aria-label={photo ? `预览 ${photo.fileName}` : '任务图片预览'}>{(photo?.thumbnailSrc || photo?.src) ? <img src={photo.thumbnailSrc || photo.src} alt={photo.fileName} /> : <TaskKindIcon kind={task.kind} />}</button><span className="task-title"><strong>{taskImageName(task, photos)}</strong><small>{taskScope(task)}</small></span><span className={`task-state state-${task.status}`}>{taskStage(task)}</span></div>{task.status === 'failed' && ((task.kind === 'analysis' || task.kind === 'collection-analysis') ? <AnalysisFailure code={task.errorCode} taskId={task.id} className="task-analysis-failure" /> : <div className="task-analysis-failure" role="alert">{task.kind === 'export' ? exportFailureMessage(task.errorCode ?? '') : '任务执行失败'} <code>{task.errorCode}</code></div>)}<TaskAnalysisResult task={task} /><TaskOutput task={task} photos={photos} batchTasks={tasks} onOpenViewer={openViewer} />{task.kind === 'export' && task.result && <div className="task-analysis-result">成功 {Number(task.result.succeeded) || 0} · 失败 {Number(task.result.failed) || 0}{exportTaskReport(task)?.files.map((file) => <p key={file.resultId}>{file.fileName}</p>)}{exportTaskReport(task)?.failures.map((failure) => <p key={failure.resultId}>{exportFailureMessage(failure.errorCode)} · {failure.errorCode}</p>)}</div>}</div>; })}</div></details>;
}

function TaskBar({ panelVisibility, onTogglePanel, suspended, open, onToggle, onOpenTaskCenter, onOpenViewer: openViewer, tasks, counts, photos }: { panelVisibility: { left: boolean; right: boolean }; onTogglePanel: (side: 'left' | 'right') => void; suspended: boolean; open: boolean; onToggle: () => void; onOpenTaskCenter: () => void; onOpenViewer: OpenTaskViewer; tasks: PersistedTask[] | null; counts?: Pick<TaskPage, 'activeCount' | 'queuedCount' | 'failedCount' | 'pausedCount'>; photos: Photo[] }): React.JSX.Element {
  const [expandedBatch, setExpandedBatch] = useState<{ id: string; request: number } | null>(null);
  const expandBatch = (id: string) => {
    setExpandedBatch((previous) => ({ id, request: (previous?.request ?? 0) + 1 }));
    if (!open) onToggle();
  };
  const isDemo = tasks === null;
  const visibleTasks = (tasks ?? []).filter((task) => !['completed', 'failed', 'canceled'].includes(task.status))
    .sort((left, right) => Number(['queued', 'paused'].includes(left.status)) - Number(['queued', 'paused'].includes(right.status)) || left.position - right.position);
  const runningCount = isDemo ? 0 : counts?.activeCount ?? visibleTasks.filter((task) => ['preparing', 'uploading', 'processing', 'downloading', 'saving'].includes(task.status)).length;
  const failedCount = isDemo ? 0 : counts?.failedCount ?? 0;
  const batches = groupTaskBatches(tasks ?? []);
  const onOpenViewer: OpenTaskViewer = (assetId, assetIds, options) => openViewer(assetId, assetIds ?? batches.find((batch) => batch.tasks.some((task) => task.assetId === assetId))?.tasks.flatMap((task) => task.assetId ? [task.assetId] : []), options ?? { target: 'latest-ai' });
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
        <button className="task-status-toggle" type="button" onClick={onToggle} aria-expanded={open} aria-label="后台任务" title="后台任务"><span className={`working-pulse${runningCount === 0 ? ' is-idle' : ''}`} /><span>{pendingBatches.length ? `${pendingBatches.length} 批任务` : '任务'}</span><ChevronDown size={12} className={open ? 'is-open' : ''} /></button>
        <div className="task-status-batches">{pendingBatches.slice(0, 2).map((batch) => <button type="button" className="task-status-batch" key={batch.id} onClick={() => expandBatch(batch.id)} title={`${taskLabels[batch.tasks[0]!.kind]} · ${batch.settled}/${batch.total}`}><TaskKindIcon kind={batch.tasks[0]!.kind} /><span>{taskLabels[batch.tasks[0]!.kind]} {batch.settled}/{batch.total}</span><progress aria-label="批次进度" max={Math.max(batch.total, 1)} value={batch.settled} /></button>)}</div>
        {pendingBatches.length > 2 && <button className="task-status-toggle" type="button" onClick={onToggle} aria-label="查看其余后台任务">+{pendingBatches.length - 2}</button>}{failedCount > 0 && <button className="task-status-toggle failed-count" type="button" onClick={onToggle}>失败 {failedCount}</button>}<div className="status-spacer" />
        <button className="panel-visibility-toggle" type="button" aria-label={panelVisibility.right ? '隐藏右侧栏' : '显示右侧栏'} aria-expanded={panelVisibility.right} title={panelVisibility.right ? '隐藏右侧栏（Tab 切换两侧）' : '显示右侧栏（Tab 切换两侧）'} onClick={() => onTogglePanel('right')}>{panelVisibility.right ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}</button>
      </div>
    </TaskActions>
  );
}

type LibraryWorkspaceProps = {
  active?: boolean;
  onCloseViewer?: () => void;
  onWorkflowStageChange?: (photo: Photo) => void;
  initialResultId?: string | null | undefined;
  initialVersionTarget?: string | undefined;
  resultSequence?: GenerationResult[] | undefined;
  onSelectViewerResult?: ((result: GenerationResult) => void) | undefined;
  onRemoveViewerResult?: ((resultId: string) => void) | undefined;
  view: 'library' | 'viewer';
  onOpenViewer: (assetId: string, assetIds?: string[]) => void;
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
  filterSearch: string;
  photoFilters: PhotoFilters;
  onPhotoFiltersChange: React.Dispatch<React.SetStateAction<PhotoFilters>>;
  sortDirection: 'asc' | 'desc' | undefined;
  onSortDirectionChange: (direction: 'asc' | 'desc') => void;
  onSearchChange: (value: string) => void;
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
      : props.selectedSmartCollection === 'favorites' ? '收藏照片'
        : props.selectedSmartCollection === 'unrated' ? '未评分'
          : props.selectedSmartCollection === 'unanalyzed' ? '等待 AI 分析'
            : props.selectedSmartCollection === 'to-review' ? '待审阅' : '已生成';
  }
  return props.searchQuery ? `搜索：${props.searchQuery}` : '所有照片';
}

function justifiedCardSizes(groups: { items: Photo[] }[], ratioFor: (photo: Photo) => number, width: number, targetHeight: number): Record<string, { width: number; height: number }> {
  const sizes: Record<string, { width: number; height: number }> = {};
  const gap = 10;
  for (const group of groups) {
    let row: Photo[] = [];
    let ratioSum = 0;
    const placeRow = (last: boolean) => {
      if (!row.length) return;
      const fitHeight = (width - gap * (row.length - 1)) / ratioSum;
      const height = last ? Math.min(targetHeight, fitHeight) : Math.min(targetHeight * 1.35, fitHeight);
      for (const photo of row) sizes[photo.id] = { width: height * ratioFor(photo), height };
      row = [];
      ratioSum = 0;
    };
    for (const photo of group.items) {
      const ratio = ratioFor(photo);
      if (row.length && (ratioSum + ratio) * targetHeight + gap * row.length > width) placeRow(false);
      row.push(photo);
      ratioSum += ratio;
    }
    placeRow(true);
  }
  return sizes;
}

function CatalogWorkspace(props: LibraryWorkspaceProps & { onOpenPhotoContextMenu?: (event: React.MouseEvent, photo: Photo) => void }): React.JSX.Element {
  const [versionTarget, setVersionTarget] = useState(readVersionTarget);
  const [versionResults, setVersionResults] = useState<Record<string, GenerationResult[]>>({});
  const [rawCompanions, setRawCompanions] = useState<Record<string, Photo>>({});
  useEffect(() => {
    const update = (event: Event) => setVersionTarget((event as CustomEvent<string>).detail);
    window.addEventListener(VERSION_TARGET_CHANGED_EVENT, update);
    return () => window.removeEventListener(VERSION_TARGET_CHANGED_EVENT, update);
  }, []);
  const versionAssetKey = JSON.stringify(props.availablePhotos.map((photo) => photo.id));
  useEffect(() => {
    if (props.isDemo) return;
    const photos = props.availablePhotos.filter((photo) => !isRawPhoto(photo) && !photo.workflow?.members.some((member) => isRawPhoto(member.asset) && !member.asset.offline));
    if (!photos.length) return;
    let active = true;
    void (async () => {
      const next: Record<string, Photo> = {};
      for (let offset = 0; offset < photos.length; offset += 100) {
        const companions = await window.desktopApi.previewCatalogCompanions(photos.slice(offset, offset + 100).map((photo) => photo.id));
        const rawFiles = companions.files.filter((file) => file.kind === 'raw' && file.assetId);
        const rawIds = [...new Set(rawFiles.map((file) => file.assetId!))];
        if (!rawIds.length) continue;
        const page = await window.desktopApi.listCatalogAssetPage({ assetIds: rawIds, workflow: false });
        const byId = new Map(mapCatalogAssets(page.items).map((photo) => [photo.id, photo]));
        for (const file of rawFiles) {
          const raw = byId.get(file.assetId!);
          if (raw) next[file.sourceAssetId] = raw;
        }
      }
      if (active) setRawCompanions(next);
    })().catch(() => undefined);
    return () => { active = false; };
  }, [versionAssetKey, props.isDemo]);
  useEffect(() => {
    if (props.isDemo || (versionTarget !== 'latest-ai' && versionTarget !== 'preferred-ai')) return;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const ids = JSON.parse(versionAssetKey) as string[];
        for (let offset = 0; active && offset < ids.length; offset += 8) {
          const entries = await Promise.all(ids.slice(offset, offset + 8).map(async (id) => [id, await window.desktopApi.listGenerationResults(id)] as const));
          if (active) setVersionResults((current) => ({ ...current, ...Object.fromEntries(entries) }));
        }
      } catch { /* Retry on the next refresh. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [versionAssetKey, versionTarget, props.isDemo]);
  const versionStages = [...new Map(props.availablePhotos.flatMap((photo) => resolveViewerVersion(photo, [], versionTarget).stages).map((stage) => [stage.id, stage])).values()];
  const rawAvailable = props.availablePhotos.some((photo) => isRawPhoto(photo) || photo.workflow?.members.some((member) => isRawPhoto(member.asset) && !member.asset.offline) || Boolean(rawCompanions[photo.id]));
  const previewPhoto = (photo: Photo): Photo => {
    if (props.isDemo) return photo;
    if (versionTarget === 'raw' && rawCompanions[photo.id]) return rawCompanions[photo.id]!;
    const { result, member } = resolveViewerVersion(photo, versionResults[photo.id] ?? [], versionTarget);
    if (result) return { ...photo, src: result.resultUrl, thumbnailSrc: result.resultUrl };
    return member ? mapCatalogAssets([member.asset])[0]! : photo;
  };
  const { minimumRating, ratingOperator, flags, colors } = props.photoFilters;
  const filtered = Boolean(props.searchQuery.trim() || minimumRating !== null || flags.length || colors.length || props.favoriteOnly);
  const [groupDetails, setGroupDetails] = useState<Record<string, { modifiedAt: number | undefined; data: FileDetails | null }>>({});
  const detailRequests = useRef(new Set<string>());
  const needsDetails = props.photoFilters.groupBy.some((dimension) => metadataDimensions.has(dimension));
  const missingDetails = needsDetails && !props.isDemo ? props.availablePhotos.filter((photo) => !groupDetails[photo.id] || groupDetails[photo.id]?.modifiedAt !== photo.modifiedAt) : [];
  useEffect(() => {
    if (!needsDetails || props.isDemo) return;
    const missing = props.availablePhotos.filter((photo) => (!groupDetails[photo.id] || groupDetails[photo.id]?.modifiedAt !== photo.modifiedAt) && !detailRequests.current.has(photo.id));
    if (!missing.length) return;
    let active = true;
    const load = async () => {
      for (let index = 0; active && index < missing.length; index += 6) {
        const batch = missing.slice(index, index + 6);
        batch.forEach((photo) => detailRequests.current.add(photo.id));
        const results = await Promise.all(batch.map(async (photo) => {
          const data = await window.desktopApi.getFileDetails(photo.id).catch(() => null);
          return [photo.id, { modifiedAt: photo.modifiedAt, data }] as const;
        }));
        batch.forEach((photo) => detailRequests.current.delete(photo.id));
        if (active) setGroupDetails((current) => ({ ...current, ...Object.fromEntries(results) }));
      }
    };
    void load();
    return () => { active = false; };
  }, [needsDetails, props.isDemo, props.availablePhotos, groupDetails]);
  const metadata = useMemo(() => Object.fromEntries(props.availablePhotos.flatMap((photo) => {
    const entry = groupDetails[photo.id];
    return entry && entry.modifiedAt === photo.modifiedAt ? [[photo.id, entry.data]] : [];
  })) as Record<string, FileDetails | null>, [groupDetails, props.availablePhotos]);
  const photoGroups = useMemo(() => groupCatalogPhotos(props.availablePhotos, props.photoFilters.groupBy, props.catalogFolders, props.photoFilters.groupOrder, metadata), [props.availablePhotos, props.photoFilters.groupBy, props.photoFilters.groupOrder, props.catalogFolders, metadata]);
  const grouped = props.photoFilters.groupBy.length > 0;
  const defaultGroupTitle = collectionTitle(props);
  const setFilter = <K extends keyof PhotoFilters>(key: K, value: React.SetStateAction<PhotoFilters[K]>) => {
    props.onPhotoFiltersChange((current) => ({ ...current, [key]: typeof value === 'function' ? (value as (old: PhotoFilters[K]) => PhotoFilters[K])(current[key]) : value }));
  };
  const selection = props.selection;
  const setSelection = props.onSelectionChange;
  const gridRef = useRef<HTMLElement>(null);
  const marqueeOriginRef = useRef<{ x: number; y: number; additive: boolean; initialIds: Set<string> } | null>(null);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [viewMode, setViewMode] = useState<CatalogViewMode>(() => {
    try { const saved = window.localStorage.getItem('photoallisai.catalog-view-mode'); return saved === 'analysis' ? 'list' : saved === 'list' || saved === 'masonry' || saved === 'justified' ? saved : saved === 'grid' ? 'grid' : 'justified'; } catch { return 'justified'; }
  });
  const [visibleColumns, setVisibleColumns] = useState<CatalogColumn[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('photoallisai.catalog-columns') ?? 'null');
      if (Array.isArray(saved)) return ['name', ...catalogColumns.filter((column) => column.id !== 'name' && saved.includes(column.id)).map((column) => column.id)];
      if (localStorage.getItem('photoallisai.catalog-view-mode') === 'analysis') return ['thumbnail', 'name', 'rating', 'analysis', 'suggestions'];
    } catch { /* restricted storage */ }
    return ['thumbnail', 'name', 'rating'];
  });
  const [columnMenu, setColumnMenu] = useState<{ x: number; y: number } | null>(null);
  const [cardWidth, setCardWidth] = useState(155);
  const [gridWidth, setGridWidth] = useState(0);
  const [thumbnailSize, setThumbnailSize] = useState(() => {
    try { const saved = Number(localStorage.getItem('photoallisai.thumbnail-size')); return saved > 0 ? clamp(saved, 100, 420) : 155; } catch { return 155; }
  });
  const zoomAnchor = useRef<{ id: string; top: number } | null>(null);
  const [listAnalyses, setListAnalyses] = useState<Record<string, AnalysisResult | null>>({});
  const analysisColumnsVisible = viewMode === 'list' && (visibleColumns.includes('analysis') || visibleColumns.includes('suggestions'));
  useEffect(() => {
    if (!analysisColumnsVisible || props.isDemo) return;
    let active = true;
    const load = async () => {
      for (let index = 0; active && index < props.availablePhotos.length; index += 4) {
        const results = await Promise.all(props.availablePhotos.slice(index, index + 4).map(async (photo) => {
          try { return [photo.id, (await window.desktopApi.listAnalysisRevisions(photo.id))[0]?.result ?? null] as const; }
          catch { return [photo.id, null] as const; }
        }));
        if (active) setListAnalyses((current) => ({ ...current, ...Object.fromEntries(results) }));
      }
    };
    void load();
    window.addEventListener(TASKS_CHANGED_EVENT, load);
    return () => { active = false; window.removeEventListener(TASKS_CHANGED_EVENT, load); };
  }, [analysisColumnsVisible, props.availablePhotos, props.isDemo]);
  useEffect(() => {
    if (!columnMenu) return;
    const close = () => setColumnMenu(null);
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', keydown, true); window.removeEventListener('resize', close); };
  }, [columnMenu]);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || viewMode === 'list') return;
    const wheel = (event: WheelEvent) => {
      // Chromium exposes trackpad pinch gestures as Ctrl+wheel events.
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const card = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.catalog-card');
      if (card?.dataset.assetId) zoomAnchor.current = { id: card.dataset.assetId, top: card.getBoundingClientRect().top };
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? grid.clientHeight : 1);
      setThumbnailSize((current) => clamp(current * Math.exp(-clamp(delta, -200, 200) * .002), 100, 420));
    };
    grid.addEventListener('wheel', wheel, { passive: false });
    return () => grid.removeEventListener('wheel', wheel);
  }, [viewMode, props.availablePhotos.length]);
  useEffect(() => { try { localStorage.setItem('photoallisai.thumbnail-size', String(thumbnailSize)); } catch { /* restricted storage */ } }, [thumbnailSize]);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    const anchor = zoomAnchor.current;
    if (grid && anchor) {
      const card = [...grid.querySelectorAll<HTMLElement>('.catalog-card')].find((item) => item.dataset.assetId === anchor.id);
      if (card) grid.scrollTop += card.getBoundingClientRect().top - anchor.top;
    }
    const frame = requestAnimationFrame(() => { zoomAnchor.current = null; });
    return () => cancelAnimationFrame(frame);
  }, [thumbnailSize, cardWidth]);
  const [aspectRatios, setAspectRatios] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || viewMode !== 'justified') return;
    const measure = () => {
      const style = getComputedStyle(grid);
      setGridWidth(grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [viewMode, props.availablePhotos.length]);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || viewMode !== 'masonry') return;
    const measure = () => {
      const card = grid.querySelector<HTMLElement>('.catalog-card');
      if (card) setCardWidth(card.getBoundingClientRect().width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [viewMode, props.availablePhotos.length, thumbnailSize, grouped]);
  const justifiedSizes = viewMode === 'justified' && gridWidth > 0 ? justifiedCardSizes(photoGroups, (photo) => {
    const preview = previewPhoto(photo);
    const src = preview.thumbnailSrc ?? preview.src;
    return clamp(aspectRatios[src] ?? IMAGE_ASPECT_RATIOS.get(src) ?? 1.5, .25, 5);
  }, gridWidth, thumbnailSize) : {};
  const orderedIds = useMemo(() => photoGroups.flatMap((group) => group.items.map((photo) => photo.id)), [photoGroups]);
  const selectedPhoto = props.availablePhotos.find((photo) => selection.focusId === photo.id) ?? null;
  const { hasMore, loadingMore, onLoadMore } = props;
  const loadMoreWhenNearEnd = useCallback((element: HTMLElement) => {
    if (!hasMore || loadingMore) return;
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (remaining <= Math.max(480, element.clientHeight * 1.5)) onLoadMore();
  }, [hasMore, loadingMore, onLoadMore]);
  const handleCatalogScroll = useCallback((event: React.UIEvent<HTMLElement>) => {
    setColumnMenu(null);
    loadMoreWhenNearEnd(event.currentTarget);
  }, [loadMoreWhenNearEnd]);
  useEffect(() => {
    // A fast scrollbar jump can reach the end before the newly appended page
    // has been painted. Recheck after each page so loading continues without
    // requiring another user scroll event.
    if (!hasMore || loadingMore || !gridRef.current) return;
    loadMoreWhenNearEnd(gridRef.current);
  }, [props.availablePhotos.length, hasMore, loadingMore, loadMoreWhenNearEnd]);

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
    const columns = Math.max(1, cards.filter((card) => card.getBoundingClientRect().top === cards[0]?.getBoundingClientRect().top).length);
    const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -columns : columns;
    let targetIndex = clamp(currentIndex + delta, 0, orderedIds.length - 1);
    if ((viewMode === 'masonry' || viewMode === 'justified' || grouped) && cards[currentIndex]) {
      const current = cards[currentIndex]!.getBoundingClientRect();
      const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
      const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      let bestDistance = Infinity;
      targetIndex = currentIndex;
      cards.forEach((card, index) => {
        const rect = card.getBoundingClientRect();
        const dx = rect.left + rect.width / 2 - (current.left + current.width / 2);
        const dy = rect.top + rect.height / 2 - (current.top + current.height / 2);
        const primary = horizontal ? dx : dy;
        const cross = horizontal ? dy : dx;
        const distance = Math.abs(primary) + Math.abs(cross) * 2;
        if (primary * direction > 1 && distance < bestDistance) { bestDistance = distance; targetIndex = index; }
      });
    }
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
  const photoImage = (photo: Photo) => {
    const preview = previewPhoto(photo);
    return <span className="catalog-list-thumb">{preview.thumbnailSrc || preview.src ? <CatalogImage src={preview.thumbnailSrc ?? preview.src} alt="" /> : <Image size={18} />}</span>;
  };
  const columns = catalogColumns.filter((column) => visibleColumns.includes(column.id));
  const listStyle = { gridTemplateColumns: `24px ${columns.map((column) => column.width).join(' ')}` };
  const field = (photo: Photo, id: CatalogColumn): React.ReactNode => {
    const analysis = listAnalyses[photo.id];
    switch (id) {
      case 'thumbnail': return photoImage(photo);
      case 'name': return <span className="catalog-list-name"><strong><PhotoFlag photo={photo} />{photo.fileName}</strong>{photo.workflow && <small>{photo.workflow.members.length} 版本</small>}{photo.workflowConflict && <small>规则冲突</small>}</span>;
      case 'format': return photo.format;
      case 'rating': return <span className="catalog-rating-cell">{photo.rating ? <>{Array.from({ length: photo.rating }, (_, index) => <Star key={index} size={11} fill="currentColor" />)}</> : '—'}</span>;
      case 'tags': return photo.tags?.map((tag) => tag.name).join('、') || '—';
      case 'analysis': return analysis?.summary ?? (photo.offline ? '文件离线' : '暂无分析');
      case 'suggestions': return analysis ? [...analysis.adjustments.global, ...analysis.adjustments.local].map((item) => item.reason).join('；') || analysis.generationRecommendation.reason || '—' : '—';
    }
  };
  const listRows = photoGroups.flatMap((group) => [...(grouped ? [<header className="catalog-group-heading" key={`group:${group.key}`}><strong>{group.title}</strong><span title="当前已加载的照片数量">{group.items.length} 张</span></header>] : []), ...group.items.map((photo) => <div className={`catalog-list-row${selection.selectedIds.has(photo.id) ? ' is-selected' : ''}${selection.focusId === photo.id ? ' is-focused' : ''}`} style={listStyle} role="option" aria-selected={selection.selectedIds.has(photo.id)} tabIndex={0} key={photo.id} data-asset-id={photo.id} data-label-color={photo.labelColor ?? undefined} aria-description={photo.labelColor ? `${photoColorName(photo.labelColor)}标签` : undefined} onClick={(event) => selectPhoto(photo, event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'replace')} onKeyDown={(event) => { if (event.key === 'Enter') props.onOpenViewer(photo.id, orderedIds); }} onContextMenu={(event) => props.onOpenPhotoContextMenu?.(event, photo)} onDoubleClick={() => { selectPhoto(photo, 'replace'); props.onOpenViewer(photo.id, orderedIds); }}>
    {selectButton(photo)}{columns.map((column) => <span className={`catalog-list-cell catalog-list-cell-${column.id}`} key={column.id}>{field(photo, column.id)}</span>)}
  </div>)]);
  return (
    <>
      <main className="catalog-main">
        <header className="catalog-toolbar">
          <PhotoFilterBar scope="图库" search={props.filterSearch} setSearch={props.onSearchChange} minimumRating={minimumRating} setMinimumRating={(value) => setFilter('minimumRating', value)} ratingOperator={ratingOperator} setRatingOperator={(value) => setFilter('ratingOperator', value)} flags={flags} setFlags={(value) => setFilter('flags', value)} colors={colors} setColors={(value) => setFilter('colors', value)} onlyFavorites={false} setOnlyFavorites={props.onFavoriteOnlyChange} favoriteOnly={props.favoriteOnly} onFavoriteOnlyChange={props.onFavoriteOnlyChange} renderTools={(filterTools) => <CatalogBrowseControls value={props.photoFilters} onChange={(next) => props.onPhotoFiltersChange((current) => ({ ...current, ...next }))} pending={missingDetails.length + (needsDetails ? Math.max(0, props.totalCount - props.availablePhotos.length) : 0)} total={props.totalCount} tools={{
            ...filterTools,
            title: <strong className="catalog-toolbar-title" title={defaultGroupTitle}>{defaultGroupTitle}</strong>,
            count: <span className="catalog-toolbar-count" title="当前集合的文件数量">{props.totalCount} 张</span>,
            workflow: !props.isDemo && <FileWorkflowControl scope={{ folderId: props.selectedFolderId, albumId: props.selectedAlbumId }} folders={props.catalogFolders} scopeName={collectionTitle(props)} />,
            version: !props.isDemo && <VersionTargetSelect stages={versionStages} value={versionTarget} onChange={saveVersionTarget} label="图库流程版本" rawAvailable={rawAvailable} />,
            view: <div className="catalog-view-switcher" role="group" aria-label="图库视图">
              {([{ mode: 'list', label: '列表视图', icon: ListFilter }, { mode: 'grid', label: '网格视图', icon: Grid2X2 }, { mode: 'masonry', label: '瀑布流视图', icon: PanelsTopLeft }, { mode: 'justified', label: '等高瀑布流', icon: Rows3 }] as const).map(({ mode, label, icon: Icon }) => <button key={mode} className={viewMode === mode ? 'is-active' : ''} type="button" aria-label={label} title={label} aria-pressed={viewMode === mode} onClick={() => changeViewMode(mode)}><Icon size={14} /></button>)}
            </div>,
            sort: <div className="sort-control"><select aria-label="图库排序" value={props.sortBy} onChange={(event) => props.onSortByChange(event.target.value as CatalogSort)}><option value="modifiedAt">修改时间</option><option value="fileName">文件名</option><option value="rating">评分</option></select><button type="button" aria-label={`图库排序：${(props.sortDirection ?? (props.sortBy === 'fileName' ? 'asc' : 'desc')) === 'asc' ? '正序' : '逆序'}，点击切换`} title="切换排序方向" onClick={() => props.onSortDirectionChange((props.sortDirection ?? (props.sortBy === 'fileName' ? 'asc' : 'desc')) === 'asc' ? 'desc' : 'asc')}>{(props.sortDirection ?? (props.sortBy === 'fileName' ? 'asc' : 'desc')) === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}</button></div>
          }} />} />
        </header>
        {props.availablePhotos.length === 0 ? (
          <section className="catalog-empty">
            {props.catalogFolders.length === 0 ? <FolderOpen size={34} /> : <Search size={34} />}
            <h2>{filtered ? '没有匹配的照片' : props.catalogFolders.length === 0 ? '添加照片文件夹' : '此集合为空'}</h2>
            <p>{props.catalogFolders.length === 0 ? '不会复制或修改原图，只建立本地索引。' : '请选择其他目录或调整筛选条件。'}</p>
            {props.catalogFolders.length === 0 && <button className="primary-action compact" type="button" onClick={() => void props.onImportFolders()}><Plus size={14} />选择文件夹</button>}
          </section>
        ) : viewMode === 'list' ? (
          <section className="catalog-list-view" role="listbox" aria-multiselectable="true" ref={gridRef} tabIndex={0} onScroll={handleCatalogScroll} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && !(event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]'))) { event.preventDefault(); setSelection(selectAll(orderedIds)); } }} aria-label="图库列表视图"><div className="catalog-list-header" style={listStyle} onContextMenu={(event) => { event.preventDefault(); setColumnMenu({ x: event.clientX, y: event.clientY }); }}><input className="catalog-list-select" type="checkbox" aria-label="全选当前列表" title="全选当前列表" checked={allVisibleSelected} ref={(element) => { if (element) element.indeterminate = someVisibleSelected && !allVisibleSelected; }} onChange={() => setSelection(allVisibleSelected ? { selectedIds: new Set(), anchorId: null, focusId: null } : selectAll(orderedIds))} />{columns.map((column) => <span key={column.id}>{column.label}</span>)}</div>{listRows}{props.hasMore && <button className="catalog-load-more" type="button" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? '加载中…' : '加载更多'}</button>}</section>
        ) : (
          <section className={`catalog-grid${viewMode === 'masonry' ? ' catalog-masonry' : ''}${viewMode === 'justified' ? ' catalog-justified' : ''}${grouped ? ' is-grouped' : ''}`} style={{ '--thumbnail-size': `${thumbnailSize}px`, '--thumbnail-height': `${Math.round(thumbnailSize * 112 / 155)}px` } as React.CSSProperties} role="listbox" aria-label="图库照片" aria-multiselectable="true" ref={gridRef} tabIndex={0} onScroll={handleCatalogScroll} onPointerDown={(event) => {
            if (event.button !== 0 || (event.target !== event.currentTarget && !(event.target instanceof Element && event.target.classList.contains('catalog-group-grid')))) return;
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
            if (event.key === 'Enter' && selectedPhoto) props.onOpenViewer(selectedPhoto.id, orderedIds);
            moveGridFocus(event);
          }}>
            {photoGroups.flatMap((group) => {
              const cards = group.items.map((photo) => {
                const preview = previewPhoto(photo);
                const justifiedSize = justifiedSizes[photo.id];
                const metadataHeight = 24 + 16 * (Number(photo.rating > 0) + Number(Boolean(photo.workflow)) + Number(Boolean(photo.workflowConflict)));
                return <button className={`catalog-card${selection.selectedIds.has(photo.id) ? ' is-selected' : ''}${selection.focusId === photo.id ? ' is-focused' : ''}${photo.offline ? ' is-offline' : ''}`} style={viewMode === 'masonry' ? { gridRowEnd: `span ${Math.ceil(cardWidth / (aspectRatios[preview.thumbnailSrc ?? preview.src] ?? 1.5) + metadataHeight + 10)}` } : viewMode === 'justified' && justifiedSize ? { width: justifiedSize.width, '--thumbnail-height': `${justifiedSize.height}px` } as React.CSSProperties : undefined} type="button" role="option" aria-selected={selection.selectedIds.has(photo.id)} aria-grabbed={selection.selectedIds.has(photo.id)} data-asset-id={photo.id} data-label-color={photo.labelColor ?? undefined} aria-description={photo.labelColor ? `${photoColorName(photo.labelColor)}标签` : undefined} draggable key={photo.id} onDragStart={(event) => { preparePhotoDrag(event, photo, selection); }} onContextMenu={(event) => props.onOpenPhotoContextMenu?.(event, photo)} onClick={(event) => selectPhoto(photo, event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'replace')} onDoubleClick={() => { if (!selection.selectedIds.has(photo.id)) selectPhoto(photo, 'replace'); props.onOpenViewer(photo.id, orderedIds); }}>
              <span className="catalog-card-image"><span className="raw-placeholder"><Image size={25} /><small>{photo.format}</small></span>{preview.thumbnailSrc || preview.src ? <CatalogImage src={preview.thumbnailSrc ?? preview.src} previewSrc={preview.src} onAspectRatio={(ratio) => { const src = preview.thumbnailSrc ?? preview.src; setAspectRatios((current) => current[src] === ratio ? current : { ...current, [src]: ratio }); }} /> : null}{selection.selectedIds.has(photo.id) && <span className="selection-check"><Check size={12} /></span>}{photo.offline && <i className="offline-badge">离线</i>}</span>
              <span className="catalog-photo-badges"><PhotoFlag photo={photo} /></span>
              <span className="catalog-card-meta"><strong title={photo.fileName}>{photo.fileName}</strong>{photo.rating > 0 && <span className="catalog-card-rating" aria-label={`${photo.rating} 星`}>{Array.from({ length: photo.rating }, (_, index) => <Star key={index} size={10} fill="currentColor" />)}</span>}{photo.workflow && <small title={`${photo.workflow.name} · 按规则关联`}>{photo.workflow.members.length} 版本</small>}{photo.workflowConflict && <small title="多条流程规则同时匹配，已保留独立显示">规则冲突</small>}</span>
            </button>;
              });
              // Keep cards under the same parent so grouping preserves decoded images and focus.
              return grouped ? [<header className="catalog-photo-group catalog-group-heading" key={`group:${group.key}`}><strong>{group.title}</strong><span title="当前已加载的照片数量">{group.items.length} 张</span></header>, ...cards] : cards;
            })}
            {props.hasMore && <button className="catalog-load-more" type="button" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? '加载中…' : '加载更多'}</button>}
            {marquee && <span className="selection-marquee" style={marquee} aria-hidden="true" />}
          </section>
        )}
      </main>
      {columnMenu && <div className="folder-context-menu catalog-column-menu" role="menu" aria-label="显示字段" style={{ left: Math.max(8, Math.min(columnMenu.x, window.innerWidth - 220)), top: Math.max(8, Math.min(columnMenu.y, window.innerHeight - 280)) }} onPointerDown={(event) => event.stopPropagation()}>
        {catalogColumns.map((column) => <button type="button" role="menuitemcheckbox" aria-checked={visibleColumns.includes(column.id)} disabled={column.id === 'name'} key={column.id} onClick={() => {
          const next = visibleColumns.includes(column.id) ? visibleColumns.filter((id) => id !== column.id) : [...visibleColumns, column.id];
          setVisibleColumns(next);
          try { localStorage.setItem('photoallisai.catalog-columns', JSON.stringify(next)); } catch { /* restricted storage */ }
        }}><span className="catalog-column-check">{visibleColumns.includes(column.id) && <Check size={14} />}</span>{column.label}</button>)}
      </div>}
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
    onAddAssetsToAgent,
    onAddAssetsToBatch
  } = props;
  const [viewerToolbarHost, setViewerToolbarHost] = useState<HTMLDivElement | null>(null);
  const [filmstripVersionTarget, setFilmstripVersionTarget] = useState<string | undefined>(props.initialVersionTarget);
  const [filmstripVisibleIds, setFilmstripVisibleIds] = useState<string[] | null>(null);
  const [operationNotice, setOperationNotice] = useTransientNotice();
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
  const [rawCompanion, setRawCompanion] = useState<Photo | null>(null);
  const [filmstripRawCompanions, setFilmstripRawCompanions] = useState<Record<string, Photo>>({});
  const filmstripRawIds = JSON.stringify(availablePhotos.map((photo) => photo.id));
  useEffect(() => {
    if (isDemo || filmstripVersionTarget !== 'raw') return;
    let active = true;
    void (async () => {
      const photos = availablePhotos.filter((photo) => !isRawPhoto(photo) && !photo.workflow?.members.some((member) => isRawPhoto(member.asset) && !member.asset.offline));
      const next: Record<string, Photo> = {};
      for (let offset = 0; offset < photos.length; offset += 100) {
        const preview = await window.desktopApi.previewCatalogCompanions(photos.slice(offset, offset + 100).map((photo) => photo.id));
        const rawFiles = preview.files.filter((file) => file.kind === 'raw' && file.assetId);
        const rawIds = [...new Set(rawFiles.map((file) => file.assetId!))];
        if (!rawIds.length) continue;
        const page = await window.desktopApi.listCatalogAssetPage({ assetIds: rawIds, workflow: false });
        const byId = new Map(mapCatalogAssets(page.items).map((photo) => [photo.id, photo]));
        for (const file of rawFiles) {
          const raw = byId.get(file.assetId!);
          if (raw) next[file.sourceAssetId] = raw;
        }
      }
      if (active) setFilmstripRawCompanions(next);
    })().catch(() => undefined);
    return () => { active = false; };
  }, [isDemo, filmstripVersionTarget, filmstripRawIds]);
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
  const [photoContextMenu, setPhotoContextMenu] = useState<{ x: number; y: number; filmstrip?: FilmstripMenuOptions | undefined; resultId?: string | null | undefined } | null>(null);
  const [selectedExportPresetId, setSelectedExportPresetId] = useState<string | null>(exportPresets[0]?.id ?? null);
  const [exportSelectionMode, setExportSelectionMode] = useState<ExportSelectionMode>('preferred-or-latest');
  const [trackedExport, setTrackedExport] = useState<{ taskId: string; notice: string; surface: 'viewer' | 'operation' } | null>(null);
  const trackedExportTaskId = trackedExport?.taskId ?? null;
  const trackedExportSurface = trackedExport?.surface ?? null;
  const selected = availablePhotos.find((photo) => photo.id === selectedAssetId) ?? availablePhotos.find((photo) => photo.id === selectedId) ?? availablePhotos[0]!;
  const currentAnalysisRevision = analysisAssetId === selected.id ? analysisRevision : undefined;
  const currentGenerationResults = generationAssetId === selected.id ? generationResults : [];
  const orderedIds = useMemo(() => {
    const ids = availablePhotos.map((photo) => photo.id);
    return view === 'viewer' && filmstripVisibleIds ? ids.filter((id) => filmstripVisibleIds.includes(id)) : ids;
  }, [availablePhotos, filmstripVisibleIds, view]);
  useEffect(() => {
    if (view !== 'viewer') return;
    const currentIndex = orderedIds.indexOf(selected.id);
    const adjacent = [orderedIds[currentIndex - 1], orderedIds[currentIndex + 1]].map((id) => availablePhotos.find((photo) => photo.id === id));
    for (const photo of adjacent) {
      const src = photo?.src;
      if (!src || DECODED_IMAGE_SOURCES.has(src) || VIEWER_IMAGE_PRELOADS.has(src)) continue;
      const image = new window.Image();
      image.decoding = 'async';
      image.src = src;
      VIEWER_IMAGE_PRELOADS.set(src, image);
      void image.decode().then(() => {
        DECODED_IMAGE_SOURCES.add(src);
        if (image.naturalHeight > 0) IMAGE_ASPECT_RATIOS.set(src, image.naturalWidth / image.naturalHeight);
      }).catch(() => VIEWER_IMAGE_PRELOADS.delete(src));
    }
    while (VIEWER_IMAGE_PRELOADS.size > 4) {
      const oldest = VIEWER_IMAGE_PRELOADS.keys().next().value;
      if (!oldest) break;
      VIEWER_IMAGE_PRELOADS.delete(oldest);
    }
  }, [availablePhotos, orderedIds, selected.id, view]);
  const collectionName = selectedFolderId
    ? catalogFolders.find((folder) => folder.id === selectedFolderId)?.name ?? '文件夹'
    : selectedAlbumId
      ? catalogAlbums.find((album) => album.id === selectedAlbumId)?.name ?? '相册'
      : selectedSmartCollection
        ? selectedSmartCollection === 'recent' ? '最近 30 天' : selectedSmartCollection === 'favorites' ? '收藏照片' : selectedSmartCollection === 'unrated' ? '未评分' : selectedSmartCollection === 'unanalyzed' ? '等待 AI 分析' : selectedSmartCollection === 'to-review' ? '待审阅' : '已生成'
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

  const { active: viewerActive, resultSequence, initialResultId, onSelectViewerResult } = props;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (viewerActive === false) return;
      if (event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest('input, textarea, select, [contenteditable="true"]') || !target.closest('.filmstrip, .catalog-grid, .catalog-list-view, .canvas-wrap')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        if (!target.closest('.filmstrip, .catalog-grid, .catalog-list-view')) return;
        event.preventDefault();
        setSelection(selectAll(orderedIds));
      } else if (!isDemo && !event.metaKey && !event.ctrlKey && !event.altKey && /^[pxu]$/i.test(event.key)) {
        event.preventDefault();
        const flag = event.key.toLowerCase() === 'p' ? 'picked' : event.key.toLowerCase() === 'x' ? 'rejected' : 'unflagged';
        const assetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
        void window.desktopApi.updateCatalogMetadata({ assetIds, flag }).then(() => onRefreshCatalog());
      } else if (!isDemo && !event.metaKey && !event.ctrlKey && !event.altKey && /^[0-5]$/.test(event.key)) {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
        event.preventDefault();
        const assetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
        void window.desktopApi.updateCatalogMetadata({ assetIds, rating: Number(event.key) }).then(() => onRefreshCatalog());
      } else if (!isDemo && !event.metaKey && !event.ctrlKey && !event.altKey && /^[6-9]$/.test(event.key)) {
        const colors = ['red', 'yellow', 'green', 'blue'] as const;
        const color = colors[Number(event.key) - 6]!;
        event.preventDefault();
        const assetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
        void window.desktopApi.updateCatalogMetadata({ assetIds, labelColor: color }).then(() => onRefreshCatalog());
      } else if (view === 'viewer' && !event.metaKey && !event.ctrlKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof Element && (target.closest('.filmstrip') || target.closest('[role="slider"]')))) return;
        event.preventDefault();
        if (resultSequence?.length) {
          const index = resultSequence.findIndex((result) => result.id === initialResultId);
          const next = resultSequence[clamp(index + (event.key === 'ArrowLeft' ? -1 : 1), 0, resultSequence.length - 1)];
          if (next) onSelectViewerResult?.(next);
          return;
        }
        const currentIndex = orderedIds.indexOf(selected.id);
        const nextId = orderedIds[clamp(currentIndex < 0 ? (event.key === 'ArrowLeft' ? orderedIds.length - 1 : 0) : currentIndex + (event.key === 'ArrowLeft' ? -1 : 1), 0, orderedIds.length - 1)];
        const nextPhoto = availablePhotos.find((photo) => photo.id === nextId);
        if (!nextPhoto || nextPhoto.id === selected.id) return;
        setSelectedId(nextPhoto.id);
        onSelectedAssetChange(nextPhoto.id);
        setSelection((current) => updateSelection(current, orderedIds, nextPhoto.id, event.shiftKey ? 'range' : 'replace'));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [viewerActive, resultSequence, initialResultId, onSelectViewerResult, availablePhotos, isDemo, onRefreshCatalog, onSelectedAssetChange, orderedIds, selected.id, selection.selectedIds, setSelection, view]);

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
    if (isDemo || isRawPhoto(selected) || selected.workflow?.members.some((member) => isRawPhoto(member.asset) && !member.asset.offline)) {
      setRawCompanion(null);
      return;
    }
    let active = true;
    setRawCompanion(null);
    void window.desktopApi.previewCatalogCompanions([selected.id]).then(async (preview) => {
      const id = preview.files.find((file) => file.sourceAssetId === selected.id && file.kind === 'raw' && file.assetId)?.assetId;
      if (!id) return;
      const page = await window.desktopApi.listCatalogAssetPage({ assetIds: [id], workflow: false });
      if (active) setRawCompanion(page.items[0] ? mapCatalogAssets([page.items[0]])[0]! : null);
    }).catch(() => { if (active) setRawCompanion(null); });
    return () => { active = false; };
  }, [isDemo, selected.id, selected.fileName, selected.workflow]);

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
      setSelection({ ...selection, anchorId: photo.id, focusId: photo.id });
      return;
    }
    setSelection((current) => updateSelection(current, orderedIds, photo.id, intent));
  };

  const openPhotoContextMenu = (event: React.MouseEvent, photo: Photo, forceSingle = false, filmstrip?: FilmstripMenuOptions, resultId?: string | null) => {
    event.preventDefault();
    if (forceSingle || !selection.selectedIds.has(photo.id)) {
      setSelection({ selectedIds: new Set([photo.id]), anchorId: photo.id, focusId: photo.id });
    }
    setSelectedId(photo.id);
    onSelectedAssetChange(photo.id);
    setPhotoContextMenu({ x: event.clientX, y: event.clientY, filmstrip, resultId });
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

  const setLabelColor = async (labelColor: Photo['labelColor']) => {
    if (isDemo) return;
    const assetIds = selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id];
    await window.desktopApi.updateCatalogMetadata({ assetIds, labelColor });
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
      if (reviewState === 'rejected') {
        await window.desktopApi.trashGenerationResult({ resultId });
        setGenerationResults((current) => current.filter((result) => result.id !== resultId));
        props.onRemoveViewerResult?.(resultId);
        setOperationNotice('已拒绝并移入应用回收站。');
        return;
      }
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
        <Viewer resultSequence={props.resultSequence} photo={selected} results={currentGenerationResults} resultsLoading={generationAssetId !== selected.id} initialVersionTarget={props.initialVersionTarget} onVersionTargetChange={setFilmstripVersionTarget} rawCompanion={rawCompanion} isDemo={isDemo} trackedExportNotice={trackedExport?.surface === 'viewer' ? trackedExport.notice : ''} onReview={reviewResult} onOpenContextMenu={(event, resultId) => openPhotoContextMenu(event, selected, true, undefined, resultId)} onClose={props.onCloseViewer} initialResultId={props.initialResultId} onToolbarHostChange={setViewerToolbarHost} onWorkflowStageChange={props.onWorkflowStageChange} />
        <PaneSplitter orientation="horizontal" value={viewerLayout.filmstripHeight} minimum={72} maximum={320} label="调整大图和胶片带高度" invert onChange={(value) => setViewerLayout('filmstripHeight', value)} />
        {props.resultSequence && props.onSelectViewerResult ? <ResultFilmstrip results={props.resultSequence} selectedId={props.initialResultId} onSelect={props.onSelectViewerResult} /> : <Filmstrip versionTarget={isDemo ? undefined : filmstripVersionTarget} rawCompanions={filmstripRawCompanions} activeGenerationResults={generationAssetId === selected.id ? currentGenerationResults : undefined} toolbarHost={viewerToolbarHost} items={availablePhotos} selected={selected} selection={selection} onSelect={selectPhoto} onSelectionChange={setSelection} onFocusPhoto={(photo) => { setSelectedId(photo.id); onSelectedAssetChange(photo.id); }} collectionName={collectionName} totalCount={totalCount} favoriteOnly={favoriteOnly} onFavoriteOnlyChange={onFavoriteOnlyChange} sortBy={sortBy} onSortByChange={onSortByChange} hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} onVisibleIdsChange={setFilmstripVisibleIds} onOpenContextMenu={(event, photo, options) => openPhotoContextMenu(event, photo, false, options)} />}
      </main>}
      {photoContextMenu && <ContextMenuSurface className="folder-context-menu photo-context-menu" role="menu" aria-label={`照片菜单 ${selection.selectedIds.size} 张`} style={{ left: Math.min(photoContextMenu.x, Math.max(8, window.innerWidth - 244)), top: Math.min(photoContextMenu.y, Math.max(8, window.innerHeight - 530)) }} onPointerDown={(event) => event.stopPropagation()}>
        {!isDemo && selection.selectedIds.size === 1 && <><button type="button" role="menuitem" onClick={() => { void window.desktopApi.openAssetExternally(selected.id).catch((error: unknown) => setOperationNotice(error instanceof Error ? error.message : '无法打开文件')); setPhotoContextMenu(null); }}><Image size={14} /><span>用默认应用打开</span></button><button type="button" role="menuitem" onClick={() => { void window.desktopApi.getFileDetails(selected.id).then((details) => navigator.clipboard.writeText(details.path)).catch(() => setOperationNotice('无法复制文件路径')); setPhotoContextMenu(null); }}><Copy size={14} /><span>复制文件路径</span></button></>}
        <div className="folder-menu-title"><Image size={14} /><span>{selection.selectedIds.size > 1 ? `${selection.selectedIds.size} 张照片` : selected.fileName}</span></div>
        <div className="photo-menu-rating"><span>评分</span><button type="button" aria-label="清除评分" onClick={() => { void rateSelection(0); setPhotoContextMenu(null); }}>0</button>{[1, 2, 3, 4, 5].map((rating) => <button type="button" aria-label={`${rating} 星`} key={rating} onClick={() => { void rateSelection(rating); setPhotoContextMenu(null); }}><Star size={12} fill={rating <= selected.rating && selection.selectedIds.size === 1 ? 'currentColor' : 'none'} /></button>)}</div>
        {!isDemo && <div className="photo-menu-flags" role="group" aria-label="设置旗标"><span>旗标</span>{(['picked', 'rejected', 'unflagged'] as const).map((flag, index) => <button type="button" key={flag} title={`${['留用', '排除', '无旗标'][index]} (${['P', 'X', 'U'][index]})`} aria-label={['留用', '排除', '无旗标'][index]} aria-pressed={selection.selectedIds.size <= 1 && (selected.flag ?? 'unflagged') === flag} onClick={() => { void window.desktopApi.updateCatalogMetadata({ assetIds: selection.selectedIds.size ? [...selection.selectedIds] : [selected.id], flag }).then(() => onRefreshCatalog()); setPhotoContextMenu(null); }}><span className="photo-flag-cross"><Flag size={15} fill={flag === 'unflagged' ? 'none' : 'currentColor'} />{flag === 'rejected' && <X size={10} />}</span></button>)}</div>}
        <div className="photo-menu-labels" role="group" aria-label="颜色标签">{(['red', 'yellow', 'green', 'blue', 'purple'] as const).map((id, index) => {
          const active = (selection.selectedIds.size ? [...selection.selectedIds] : [selected.id]).every((assetId) => availablePhotos.find((photo) => photo.id === assetId)?.labelColor === id);
          return <button className={active ? 'is-active' : ''} key={id} type="button" title={`${photoColorName(id)}标签${index < 4 ? ` (${index + 6})` : ''}`} aria-label={`${photoColorName(id)}标签`} aria-pressed={active} onClick={() => { void setLabelColor(id); setPhotoContextMenu(null); }}><i className={`photo-color-swatch is-${id}`} /></button>;
        })}<button type="button" aria-label="清除颜色标签" title="清除颜色标签" onClick={() => { void setLabelColor(null); setPhotoContextMenu(null); }}><X size={13} /></button></div>
        <button type="button" role="menuitem" onClick={() => { void favoriteSelection(![...selection.selectedIds].every((id) => availablePhotos.find((photo) => photo.id === id)?.favorite)); setPhotoContextMenu(null); }}><Heart size={14} /><span>{[...selection.selectedIds].every((id) => availablePhotos.find((photo) => photo.id === id)?.favorite) ? '取消收藏' : '添加到收藏'}</span></button>
        <button type="button" role="menuitem" onClick={() => { setTagEditorOpen(true); setPhotoContextMenu(null); }}><Tags size={14} /><span>添加标签…</span></button>
        <span className="folder-menu-separator" />
        <button type="button" role="menuitem" onClick={() => { void analyzeSelection(); setPhotoContextMenu(null); }}><Sparkles size={14} /><span>AI 分析{selection.selectedIds.size > 1 ? ` ${selection.selectedIds.size} 张` : ''}</span></button>
        <button type="button" role="menuitem" onClick={() => { onAddAssetsToAgent?.(selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id]); setPhotoContextMenu(null); }}><Bot size={14} /><span>加入 Agent 批处理{selection.selectedIds.size > 1 ? `（${selection.selectedIds.size} 张）` : ''}</span></button>
        <button type="button" role="menuitem" onClick={() => { onAddAssetsToBatch?.(selection.selectedIds.size > 0 ? [...selection.selectedIds] : [selected.id]); setPhotoContextMenu(null); }}><Sparkles size={14} /><span>加入 AI 批量修图{selection.selectedIds.size > 1 ? `（${selection.selectedIds.size} 张）` : ''}</span></button>
        {!photoContextMenu.resultId && <button type="button" role="menuitem" disabled={generationProfiles.length === 0} onClick={() => { void generateSelection({ providerProfileId: generationProfiles[0]!.id, template: null, count: 1, instruction: '', disabledActionIds: new Set() }); setPhotoContextMenu(null); }}><WandSparkles size={14} /><span>按默认方案生成</span></button>}
        <div className="photo-menu-export-options">{!photoContextMenu.resultId && <select aria-label="导出版本范围" value={exportSelectionMode} onChange={(event) => setExportSelectionMode(event.target.value as ExportSelectionMode)}><option value="preferred-or-latest">每张首选 / 最新版本</option><option value="accepted">所有已接受版本</option><option value="all">所有生成版本</option></select>}<select aria-label="右键菜单导出预设" value={selectedExportPresetId ?? ''} onChange={(event) => setSelectedExportPresetId(event.target.value || null)}><option value="">保留文件名 · 原格式</option>{exportPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></div>
        {photoContextMenu.resultId && <>
          <div className="folder-menu-title">生成版本 V{currentGenerationResults.find((result) => result.id === photoContextMenu.resultId)?.version}</div>
          <button type="button" role="menuitem" onClick={() => { void exportResults([photoContextMenu.resultId!]); setPhotoContextMenu(null); }}><Download size={14} /><span>导出当前版本…</span></button>
          <button type="button" role="menuitem" onClick={() => { const result = currentGenerationResults.find((item) => item.id === photoContextMenu.resultId); if (result) void regenerate(result).then(setOperationNotice).catch(() => setOperationNotice('无法再次生成，请检查模型配置。')); setPhotoContextMenu(null); }}><RotateCcw size={14} /><span>按当前方案再次生成</span></button>
          <button type="button" role="menuitem" onClick={() => { void window.desktopApi.revealGenerationResult(photoContextMenu.resultId!).catch(() => setOperationNotice('无法打开生成文件位置。')); setPhotoContextMenu(null); }}><FolderOpen size={14} /><span>在文件管理器中显示生成版本</span></button>
        </>}
        {!photoContextMenu.resultId && <button type="button" role="menuitem" onClick={() => { void exportLatestSelection(); setPhotoContextMenu(null); }}><Download size={14} /><span>导出 AI 版本…</span></button>}
        {photoContextMenu.filmstrip && <FilmstripMenu options={photoContextMenu.filmstrip} onClose={() => setPhotoContextMenu(null)} />}
        {!isDemo && <><span className="folder-menu-separator" />{selection.selectedIds.size === 1 && <button type="button" role="menuitem" onClick={() => { void window.desktopApi.revealCatalogAsset(selected.id); setPhotoContextMenu(null); }}><FolderOpen size={14} /><span>{FILE_MANAGER_LABEL}</span></button>}<button type="button" role="menuitem" onClick={() => { if (selection.selectedIds.size > 1) setBatchRenameDialogOpen(true); else openRenameDialog(); setPhotoContextMenu(null); }}><FilePenLine size={14} /><span>{selection.selectedIds.size > 1 ? '批量重命名…' : '重命名…'}</span></button><button type="button" role="menuitem" onClick={() => { void openFolderDialog('copy'); setPhotoContextMenu(null); }}><Copy size={14} /><span>复制到文件夹…</span></button><button type="button" role="menuitem" onClick={() => { void openFolderDialog('move'); setPhotoContextMenu(null); }}><FolderInput size={14} /><span>移动到文件夹…</span></button></>}
        {!isDemo && catalogAlbums.length > 0 && <div className="photo-menu-album"><FolderHeart size={14} /><select aria-label="加入相册" value={albumTargetId} onChange={(event) => setAlbumTargetId(event.target.value)}><option value="">加入相册…</option>{catalogAlbums.map((album) => <option key={album.id} value={album.id}>{album.name}</option>)}</select><button type="button" disabled={!albumTargetId} onClick={() => { void updateAlbumMembership('add', albumTargetId); setPhotoContextMenu(null); }}>加入</button></div>}
        {!isDemo && selectedAlbumId && <button type="button" role="menuitem" onClick={() => { void updateAlbumMembership('remove'); setPhotoContextMenu(null); }}><FolderHeart size={14} /><span>从当前相册移出</span></button>}
        {!isDemo && <><span className="folder-menu-separator" /><button type="button" role="menuitem" onClick={() => { setRemovalMode('remove'); setPhotoContextMenu(null); }}><LibraryBig size={14} /><span>从图库移除…</span></button><button className="is-danger" type="button" role="menuitem" onClick={() => { setRemovalMode('trash'); setPhotoContextMenu(null); }}><Trash2 size={14} /><span>移到系统回收站…</span></button></>}
      </ContextMenuSurface>}
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
  collectionReport: CollectionReport | null;
};
const WORKFLOW_DRAFT_KEY = 'photoallisai.ai-workflow.v1';
const DEFAULT_WORKFLOW_RULES: WorkflowRule[] = [
  { id: 'identity', text: '保持人物身份、脸部特征和年龄不变', enabled: true },
  { id: 'composition', text: '保持原始构图、镜头视角和主体数量', enabled: true },
  { id: 'texture', text: '保留真实皮肤纹理，避免塑料感', enabled: true },
  { id: 'scene', text: '不改变主要场景和关键物体', enabled: true }
];

function loadWorkflowDraft(): WorkflowDraft {
  const fallback: WorkflowDraft = { workflowAssetIds: [], workflowAssetMeta: {}, stage: 'analysis', templateId: '', generationCount: 1, globalRules: DEFAULT_WORKFLOW_RULES, itemRules: {}, itemTemplateIds: {}, collectionReport: null };
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
      collectionReport: value.collectionReport && typeof value.collectionReport.summary === 'string' && Array.isArray(value.collectionReport.groups) && Array.isArray(value.collectionReport.keep) && Array.isArray(value.collectionReport.review) && Array.isArray(value.collectionReport.recommendations) ? value.collectionReport : null
    };
  } catch {
    return fallback;
  }
}

function AgentDockPanel(props: React.ComponentProps<typeof AgentPanel>): React.JSX.Element {
  return <AgentPanel {...props} />;
}

function AiWorkflowPage({ photos: availablePhotos, focusId, workflowAssetIds, workflowAssetMeta, tasks, globalRules, onGlobalRulesChange, templateId, onRemoveAsset, onMoveAsset: _onMoveAsset, onClearAssets, onOpenTasks: _onOpenTasks, onFocusAsset, onOpenViewer }: { photos: Photo[]; focusId: string | null; workflowAssetIds: string[]; workflowAssetMeta: Record<string, WorkflowAssetMeta>; tasks: PersistedTask[]; globalRules: WorkflowRule[]; onGlobalRulesChange: React.Dispatch<React.SetStateAction<WorkflowRule[]>>; templateId: string; onRemoveAsset: (id: string) => void; onMoveAsset: (id: string, direction: -1 | 1) => void; onClearAssets: () => void; onOpenTasks: () => void; onFocusAsset: (id: string) => void; onOpenViewer: OpenTaskViewer }): React.JSX.Element {
  const initialDraft = useMemo(loadWorkflowDraft, []);
  const [stage, setStage] = useState<WorkflowStage>(initialDraft.stage);
  const [revisions, setRevisions] = useState<Record<string, AnalysisRevision | undefined>>({});
  const revisionPollOffset = useRef(0);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [generationProfileId, setGenerationProfileId] = useState('');
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [storageMode, setStorageMode] = useState<AppSettings['generationStorageMode']>('managed');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [collectionReport] = useState<CollectionReport | null>(initialDraft.collectionReport);
  const [generationCount, setGenerationCount] = useState(initialDraft.generationCount);
  const [itemTemplateIds] = useState<Record<string, string>>(initialDraft.itemTemplateIds);
  const [localFocusId, setLocalFocusId] = useState<string | null>(focusId);
  const [itemRules, setItemRules] = useState<Record<string, WorkflowRule[]>>(initialDraft.itemRules);
  const ids = workflowAssetIds;
  const idsKey = ids.join('|');
  const analysisTasks = useMemo(() => {
    const latest = new Map<string, PersistedTask>();
    for (const task of tasks) if (task.kind === 'analysis' && task.assetId && !latest.has(task.assetId)) latest.set(task.assetId, task);
    return latest;
  }, [tasks]);
  const completedKey = ids.map((id) => analysisTasks.get(id)?.status === 'completed' ? analysisTasks.get(id)?.id : '').join('|');
  const resolvedPhotos = useAssetPhotos(ids, availablePhotos);
  const workflowPhotos = ids.map((id) => {
    const visible = resolvedPhotos.find((photo) => photo.id === id);
    if (visible) return visible;
    const saved = workflowAssetMeta[id];
    return saved ? { ...saved, dimensions: '', rating: 0 } : null;
  }).filter((photo): photo is Photo => Boolean(photo));
  const currentId = focusId && ids.includes(focusId) ? focusId : workflowPhotos[0]?.id ?? null;
  const effectiveCurrentId = localFocusId && ids.includes(localFocusId) ? localFocusId : currentId;
  useEffect(() => {
    if (!effectiveCurrentId) return;
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-workflow-asset-id="${effectiveCurrentId}"]`)?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [effectiveCurrentId]);
  const [generationResults, setGenerationResults] = useState<Record<string, GenerationResult[]>>({});
  const [generationResultsReadyKey, setGenerationResultsReadyKey] = useState('');
  const generationResultsKeyRef = useRef('');
  const [batchContextMenu, setBatchContextMenu] = useState<{ x: number; y: number; assetId: string; resultId?: string } | null>(null);
  useEffect(() => {
    if (!batchContextMenu) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest('.batch-context-menu'))) setBatchContextMenu(null);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setBatchContextMenu(null); };
    const onBlur = () => setBatchContextMenu(null);
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [batchContextMenu]);
  const submitting = useRef(false);
  const [submissionId, setSubmissionId] = useState(() => window.localStorage.getItem(`${WORKFLOW_DRAFT_KEY}.submission`) ?? '');
  const [submissionTasks, setSubmissionTasks] = useState<PersistedTask[]>([]);
  const [regenerateConfirmation, setRegenerateConfirmation] = useState<'all' | null>(null);
  const generationTasks = useMemo(() => {
    const merged = new Map(tasks.filter((task) => task.kind === 'generation').map((task) => [task.id, task]));
    for (const task of submissionTasks) {
      if (!merged.has(task.id) || merged.get(task.id)!.updatedAt <= task.updatedAt) merged.set(task.id, task);
    }
    return [...merged.values()].sort((a, b) => b.createdAt - a.createdAt);
  }, [tasks, submissionTasks]);
  const latestGenerationTasks = (assetId: string) => {
    const assetTasks = generationTasks.filter((task) => task.assetId === assetId);
    const latest = assetTasks[0];
    return latest ? assetTasks.filter((task) => (task.payload.submissionId ?? task.payload.batchId) === (latest.payload.submissionId ?? latest.payload.batchId)) : [];
  };
  const isUnfinished = (task: PersistedTask) => !['completed', 'failed', 'canceled'].includes(task.status);
  const generationActive = generationTasks.some((task) => ids.includes(task.assetId ?? '') && isUnfinished(task));
  const batchCompleted = submissionTasks.filter((task) => task.status === 'completed').length;
  const batchFailed = submissionTasks.filter((task) => task.status === 'failed').length;
  const batchCanceled = submissionTasks.filter((task) => task.status === 'canceled').length;
  const batchQueued = submissionTasks.filter((task) => task.status === 'queued' || task.status === 'draft').length;
  const batchRunning = submissionTasks.filter((task) => isUnfinished(task) && !['queued', 'draft', 'paused'].includes(task.status)).length;
  const batchPaused = submissionTasks.filter((task) => task.status === 'paused').length;
  const batchPending = busy || batchRunning > 0 || batchQueued > 0 || batchPaused > 0;
  useEffect(() => {
    if (!/^已(?:加入|重新排队|将)/.test(notice)) return;
    const timer = window.setTimeout(() => setNotice(''), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (submissionId) return;
    const latest = tasks.filter((task) => task.kind === 'generation' && ids.includes(task.assetId ?? '')).sort((a, b) => b.createdAt - a.createdAt)[0];
    const batch = latest?.payload.submissionId ?? latest?.payload.batchId;
    if (typeof batch === 'string') setSubmissionId(batch);
  }, [ids, submissionId, tasks]);

  useEffect(() => {
    if (!submissionId) return;
    window.localStorage.setItem(`${WORKFLOW_DRAFT_KEY}.submission`, submissionId);
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const items = await window.desktopApi.listTaskBatch({ kind: 'generation', batchId: submissionId });
        if (active) setSubmissionTasks(items);
      } catch { if (active) setNotice('生成进度暂时无法更新，正在重试。可在任务中心查看。'); }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [submissionId]);

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
    if (generationResultsKeyRef.current !== idsKey) {
      generationResultsKeyRef.current = '';
      setGenerationResultsReadyKey('');
      setGenerationResults({});
    }
    if (ids.length === 0) { generationResultsKeyRef.current = idsKey; setGenerationResultsReadyKey(idsKey); return () => { active = false; }; }
    void Promise.all(ids.map(async (id) => [id, await window.desktopApi.listGenerationResults(id)] as const)).then((entries) => {
      if (active) {
        setGenerationResults(Object.fromEntries(entries));
        generationResultsKeyRef.current = idsKey;
        setGenerationResultsReadyKey(idsKey);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [ids, idsKey, tasks, submissionTasks]);
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
    const timeout = window.setTimeout(() => window.localStorage.setItem(WORKFLOW_DRAFT_KEY, JSON.stringify({ workflowAssetIds, workflowAssetMeta, stage, templateId, generationCount, globalRules, itemRules, itemTemplateIds, collectionReport })), 300);
    return () => window.clearTimeout(timeout);
  }, [collectionReport, generationCount, globalRules, itemRules, itemTemplateIds, stage, templateId, workflowAssetIds, workflowAssetMeta]);
  const openGeneratedViewer = async (candidate: GenerationResult) => {
    try {
      // Browse the same candidates shown in the queue, including earlier submissions.
      const results = workflowPhotos.flatMap((photo) => (generationResults[photo.id] ?? []).slice(0, 8));
      onOpenViewer(candidate.assetId, workflowAssetIds, { resultId: candidate.id, results });
    } catch { setNotice('无法读取该批生成图片，请稍后重试。'); }
  };

  const analyze = async () => {
    const profile = profiles.find((item) => item.purpose === 'vision' && item.enabled && item.isDefault) ?? profiles.find((item) => item.purpose === 'vision' && item.enabled);
    if (!profile) { setNotice('请先在设置中配置并启用视觉分析模型。'); return; }
    if (ids.length === 0) { setNotice('请先从图库或看图加入照片到处理队列。'); return; }
    setBusy(true); setNotice('正在加入视觉分析队列…');
    try {
      const batchId = crypto.randomUUID();
      for (const assetId of ids) {
        await window.desktopApi.enqueueTask({ kind: 'analysis', assetId, payload: { providerProfileId: profile.id, mode: 'full', batchId, locale: getLocale() } });
      }
      setNotice(`已加入 ${ids.length} 张照片的分析任务。`); setStage('optimization');
    } catch (error) { setNotice(`加入视觉分析队列失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  };
  const retryGeneration = async (failed: PersistedTask[]) => {
    if (submitting.current || failed.length === 0) return;
    submitting.current = true;
    setBusy(true);
    try {
      for (const task of failed) {
        const updated = await window.desktopApi.retryTask(task.id);
        setSubmissionTasks((current) => current.map((item) => item.id === task.id ? updated : item));
      }
      const batch = failed[0]!.payload.submissionId ?? failed[0]!.payload.batchId;
      if (typeof batch === 'string') setSubmissionId(batch);
      setNotice(`已重新排队 ${failed.length} 个失败版本，成功版本保留。`);
    } catch (error) { setNotice(`重试失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { submitting.current = false; setBusy(false); }
  };
  const generate = async (onlyAssetId?: string, force = false) => {
    if (submitting.current) return;
    if (generationResultsReadyKey !== idsKey) { setNotice('正在读取已有生成版本，请稍后再试。'); return; }
    const profile = profiles.find((item) => item.purpose === 'generation' && item.enabled && item.id === generationProfileId) ?? profiles.find((item) => item.purpose === 'generation' && item.enabled && item.isDefault) ?? profiles.find((item) => item.purpose === 'generation' && item.enabled);
    if (!profile) { setNotice('请先在设置中配置并启用图片生成模型。'); return; }
    const scopedIds = ids.filter((id) => !onlyAssetId || id === onlyAssetId);
    const usable = scopedIds
      .filter((id) => !generationTasks.some((task) => task.assetId === id && isUnfinished(task)))
      .filter((id) => force || (generationResults[id]?.length ?? 0) === 0)
      .map((assetId) => ({ assetId, revision: revisions[assetId] }));
    if (usable.length === 0) {
      const activeCount = scopedIds.filter((id) => generationTasks.some((task) => task.assetId === id && isUnfinished(task))).length;
      const resultCount = scopedIds.filter((id) => (generationResults[id]?.length ?? 0) > 0).length;
      if (activeCount > 0) setNotice('这些图片已有生成任务，请等待完成后再生成。');
      else if (resultCount > 0 && !force) setRegenerateConfirmation('all');
      else setNotice('没有可生成的图片。');
      return;
    }
    submitting.current = true;
    setBusy(true); setNotice('正在创建提示词并加入生图队列…');
    let submittedCount = 0;
    try {
      const submissionId = crypto.randomUUID();
      setSubmissionTasks([]);
      setSubmissionId(submissionId);
      for (const { assetId, revision } of usable) {
        const selectedTemplateId = itemTemplateIds[assetId] || templateId;
        const template = templates.find((item) => item.id === selectedTemplateId) ?? null;
        const enabled = (itemRules[assetId] ?? []).filter((item) => item.enabled).map((item) => item.text);
        const rules = globalRules.filter((item) => item.enabled).map((item) => item.text);
        const prompt = composeGenerationPrompt({ templateBody: template?.body ?? '{{user_instruction}}', analysis: revision ? { ...revision.result, generativeActions: revision.result.generativeActions.filter((action) => enabled.some((item) => item.startsWith(`${action.target}：`))) } : undefined, userInstruction: [...rules, ...enabled].join('\n') });
        if (!prompt.trim()) throw new Error('请填写批次提示词、本图提示词或选择模板。');
        const batchId = crypto.randomUUID();
        const count = generationCount;
        for (let resultIndex = 1; resultIndex <= count; resultIndex += 1) {
          const task = await window.desktopApi.enqueueTask({ kind: 'generation', assetId, payload: { providerProfileId: profile.id, batchId, submissionId, prompt, templateId: template?.id ?? null, templateVersion: template?.version ?? null, resultIndex, storageMode, ...(revision ? { analysisRevisionId: revision.id } : {}), disabledActionIds: revision?.result.generativeActions.filter((action) => !enabled.some((item) => item.startsWith(`${action.target}：`))).map((action) => action.id) ?? [], userInstruction: [...rules, ...enabled].join('\n') } });
          submittedCount += 1;
          setSubmissionTasks((current) => [...current.filter((item) => item.id !== task.id), task]);
        }
      }
      const taskCount = usable.length * generationCount;
      setNotice(`已将 ${usable.length} 张照片、共 ${taskCount} 个版本加入生图队列。`); setStage('review');
    } catch (error) { setNotice(`已提交 ${submittedCount} 个生成任务；${error instanceof Error ? error.message : String(error)}`); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <main className="ai-workflow-page batch-workspace" onFocusCapture={(event) => { const target = (event.target as HTMLElement).closest<HTMLElement>('[data-workflow-asset-id]'); const id = target?.dataset.workflowAssetId; if (id) { setLocalFocusId(id); onFocusAsset(id); } }}>
    <div className="workflow-body">
      <section className="workflow-main">
        <section className="batch-prompt-card"><div><span>批次整体提示词</span><label className="batch-model-choice"><select aria-label="本批生成模型" value={generationProfileId || (profiles.find((item) => item.purpose === 'generation' && item.enabled && item.isDefault) ?? profiles.find((item) => item.purpose === 'generation' && item.enabled))?.id || ''} onChange={(event) => setGenerationProfileId(event.target.value)}>{!profiles.some((item) => item.purpose === 'generation' && item.enabled) && <option value="">尚未配置生成模型</option>}{profiles.filter((item) => item.purpose === 'generation' && item.enabled).map((item) => <option key={item.id} value={item.id}>{item.name}{item.isDefault ? ' · 默认' : ''}</option>)}</select></label></div><textarea aria-label="批次整体提示词" value={globalRules.filter((item) => item.enabled).map((item) => item.text).join('\n')} onChange={(event) => onGlobalRulesChange([{ id: 'batch-prompt', text: event.target.value, enabled: true }])} placeholder="描述所有照片共有的修图要求" /></section>
        <div className="batch-queue-toolbar">
          <div className="batch-queue-heading" role="region" aria-label="本批生成进度" aria-live="polite">
            <strong>处理队列</strong>
            <span>{submissionTasks.length > 0 ? `${workflowPhotos.length} 张 · 完成 ${batchCompleted}/${submissionTasks.length}${batchFailed > 0 ? ` · 失败 ${batchFailed}` : ''}${batchCanceled > 0 ? ` · 取消 ${batchCanceled}` : ''}${batchRunning > 0 ? ` · 生成中 ${batchRunning}` : ''}${batchQueued > 0 ? ` · 排队 ${batchQueued}` : ''}${batchPaused > 0 ? ` · 暂停 ${batchPaused}` : ''}` : `${workflowPhotos.length} 张 · 待生成 ${workflowPhotos.length * generationCount} 个版本`}</span>
            {batchPending && <progress aria-label="本批已结束版本" value={batchCompleted + batchFailed + batchCanceled} max={submissionTasks.length} />}
            {batchFailed > 0 && <button className="quiet-button compact" type="button" disabled={busy || batchRunning > 0 || batchQueued > 0 || batchPaused > 0} onClick={() => void retryGeneration(submissionTasks.filter((task) => task.status === 'failed'))}>重试失败</button>}
          </div>
          <div className="batch-queue-toolbar-actions"><label><span>每图生成</span><input aria-label="默认生成数量" type="number" min="1" max="8" value={generationCount} onChange={(event) => setGenerationCount(clamp(Number(event.target.value) || 1, 1, 8))} /></label><button className="quiet-button compact" type="button" disabled={busy || workflowPhotos.length === 0} onClick={() => void analyze()}><Sparkles size={12} />视觉分析</button><button className="primary-action compact" type="button" disabled={busy || generationActive || generationResultsReadyKey !== idsKey || workflowPhotos.length === 0} onClick={() => void generate()}><WandSparkles size={12} />{busy ? '正在提交…' : generationActive ? '生成中…' : generationResultsReadyKey !== idsKey ? '读取版本…' : '生成全部'}</button><button className="quiet-button compact" type="button" aria-label="清空处理列表" title="清空处理列表（后台任务继续运行）" disabled={workflowAssetIds.length === 0} onClick={() => { onClearAssets(); setNotice('已清空处理列表。'); }}><X size={12} /></button></div>
        </div>
        {notice && <p className="workflow-notice" role="status">{notice}</p>}
        {workflowPhotos.length === 0 ? <div className="workflow-empty">从图库或看图将照片加入处理队列</div> : <div className="batch-queue-list">{workflowPhotos.map((photo) => {
            const result = revisions[photo.id]?.result;
            const task = analysisTasks.get(photo.id);
            const imageTasks = latestGenerationTasks(photo.id);
            const completed = imageTasks.filter((item) => item.status === 'completed').length;
            const failed = imageTasks.filter((item) => item.status === 'failed');
            const active = imageTasks.find((item) => isUnfinished(item) && !['queued', 'draft', 'paused'].includes(item.status));
            const pending = imageTasks.filter(isUnfinished);
            const candidates = generationResults[photo.id] ?? [];
            const state = imageTasks.length && (active || pending.length || failed.length || candidates.length === 0)
              ? `${active ? taskStage(active) : pending.length ? pending.every((item) => item.status === 'paused') ? '已暂停' : '等待生成' : failed.length ? '生成失败' : imageTasks.every((item) => item.status === 'canceled') ? '已取消' : '生成完成'} · ${completed}/${imageTasks.length}`
              : candidates.length > 0 ? `已生成 · ${candidates.length} 个版本` : task && isUnfinished(task) ? '视觉分析中' : '待生成';
            return <article className={`batch-queue-item${photo.id === effectiveCurrentId ? ' is-active' : ''}`} data-workflow-asset-id={photo.id} key={photo.id} onClick={() => { setLocalFocusId(photo.id); onFocusAsset(photo.id); }} onContextMenu={(event) => { event.preventDefault(); setLocalFocusId(photo.id); onFocusAsset(photo.id); setBatchContextMenu({ x: event.clientX, y: event.clientY, assetId: photo.id }); }}><div className="batch-queue-source" onClick={(event) => { event.stopPropagation(); onOpenViewer(photo.id, workflowAssetIds, { target: 'latest-ai' }); }}><span className="batch-queue-original" data-label-color={photo.labelColor ?? undefined}>{photo.thumbnailSrc || photo.src ? <img src={photo.thumbnailSrc ?? photo.src} alt="" /> : <Image size={20} />}<small>原图</small></span><span className="batch-queue-file"><strong>{photo.fileName}</strong><em>{active && <LoaderCircle size={12} className="batch-generation-spinner" />}{state}</em>{pending.length > 0 && <progress aria-label={`${photo.fileName} 已结束版本`} value={imageTasks.filter((item) => !isUnfinished(item)).length} max={imageTasks.length} />}</span></div><div className="batch-item-settings"><label className="batch-item-instruction"><textarea aria-label={`${photo.fileName} 本图补充要求`} value={(itemRules[photo.id] ?? []).filter((rule) => rule.enabled).map((rule) => rule.text).join('\n')} onClick={(event) => event.stopPropagation()} onChange={(event) => setItemRules((current) => ({ ...current, [photo.id]: [{ id: `prompt-${photo.id}`, text: event.target.value, enabled: true }] }))} placeholder="补充这张图片的独立要求" /></label></div><div className="batch-queue-candidates">{candidates.slice(0, 8).map((candidate, candidateIndex, visibleCandidates) => { const startsPreviousBatch = candidateIndex > 0 && candidate.batchId !== visibleCandidates[0]?.batchId && visibleCandidates[candidateIndex - 1]?.batchId === visibleCandidates[0]?.batchId; return <button data-label-color={photo.labelColor ?? undefined} className={`batch-candidate${candidate.reviewState === 'preferred' ? ' is-best' : ''}${startsPreviousBatch ? ' is-previous-batch' : ''}`} type="button" key={candidate.id} title="点击打开大图" onClick={(event) => { event.stopPropagation(); void openGeneratedViewer(candidate); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setBatchContextMenu({ x: event.clientX, y: event.clientY, assetId: photo.id, resultId: candidate.id }); }}><img src={candidate.resultUrl} alt={`生成候选 ${candidate.version}`} /><small>{candidate.reviewState === 'preferred' && <Star size={10} fill="currentColor" aria-label="首选" />}V{candidate.version}</small></button>; })}</div><div className="batch-queue-meta"><span>{failed.length > 0 ? <span className="batch-generation-error" role="alert">{failed.length} 个版本失败 · {generationFailureMessage(failed[0]!.errorCode)} <code>{failed[0]!.errorCode}</code> <button type="button" aria-label="复制生成错误" title="复制生成错误" onClick={(event) => { event.stopPropagation(); void navigator.clipboard.writeText(failed.map((item) => `图片：${photo.fileName}\n错误码：${item.errorCode ?? '未知错误'}\n任务 ID：${item.id}`).join('\n\n')); }}><Copy size={13} /></button></span> : result?.catalog.shortDescription ?? ''}</span><div><button type="button" aria-label={`${failed.length ? '重试失败版本' : '再次生成'} ${photo.fileName}`} title={failed.length ? '仅重试失败版本' : '再次生成'} disabled={busy || pending.length > 0} onClick={(event) => { event.stopPropagation(); setLocalFocusId(photo.id); onFocusAsset(photo.id); void (failed.length ? retryGeneration(failed) : generate(photo.id, true)); }}><RotateCcw size={12} /></button><button type="button" aria-label={`移除 ${photo.fileName}`} onClick={(event) => { event.stopPropagation(); onRemoveAsset(photo.id); }}><X size={12} /></button></div></div></article>;

          })}</div>}
        {batchContextMenu && <div className="batch-context-menu" role="menu" aria-label="批量修图操作" style={{ left: Math.min(batchContextMenu.x, window.innerWidth - 220), top: Math.min(batchContextMenu.y, window.innerHeight - 180) }} onPointerDown={(event) => event.stopPropagation()}><button type="button" role="menuitem" onClick={() => { void generate(batchContextMenu.assetId, true); setBatchContextMenu(null); }}><RotateCcw size={13} />再次生成</button><button type="button" role="menuitem" onClick={() => { void window.desktopApi.revealCatalogAsset(batchContextMenu.assetId); setBatchContextMenu(null); }}><FolderOpen size={13} />打开原图位置</button>{batchContextMenu.resultId && <button type="button" role="menuitem" onClick={() => { void window.desktopApi.revealGenerationResult(batchContextMenu.resultId!); setBatchContextMenu(null); }}><FolderOpen size={13} />打开生成图位置</button>}</div>}
        {regenerateConfirmation && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setRegenerateConfirmation(null); }}><section className="removal-dialog" role="alertdialog" aria-modal="true" aria-labelledby="regenerate-generation-title"><header><span className="dialog-icon"><RotateCcw size={17} /></span><div><h2 id="regenerate-generation-title">重新生成全部图片？</h2><p>当前处理列表中的图片都已有生成版本。重新生成会新增一批结果，不会覆盖或删除已有版本。</p></div></header><footer><button autoFocus className="quiet-button" type="button" disabled={busy} onClick={() => setRegenerateConfirmation(null)}>取消</button><button className="primary-action compact" type="button" disabled={busy} onClick={() => { setRegenerateConfirmation(null); void generate(undefined, true); }}>重新生成</button></footer></section></div>}
      </section>
    </div>
  </main>;
}

function SettingsPage({ onExportPresetsChange }: { onExportPresetsChange: (presets: ExportPreset[]) => void }): React.JSX.Element {
  type SettingsSection = 'appearance' | 'models' | 'workflow' | 'export' | 'storage' | 'tasks' | 'shortcuts' | 'privacy' | 'mcp' | 'diagnostics';
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
  const [centerFileNames, setCenterFileNames] = useState(catalogFileNameCentered);
  const [locale, setLocalePreference] = useState<AppSettings['locale']>('zh-CN');
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpMessage, setMcpMessage] = useState('');
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
  useEffect(() => { void window.desktopApi.getMcpStatus().then(setMcp).catch(() => setMcp(null)); }, []);

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

  const saveFileNameAlignment = (centered: boolean) => {
    setCenterFileNames(centered);
    applyCatalogFileNameAlignment(centered);
    try { localStorage.setItem(CATALOG_FILE_NAME_CENTERED_KEY, String(centered)); } catch { /* Keep the current preference for this session. */ }
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
        <button className={settingsSection === 'workflow' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('workflow')} aria-current={settingsSection === 'workflow' ? 'page' : undefined}><Layers3 size={14} />文件流程</button>
        <button className={settingsSection === 'appearance' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('appearance')} aria-current={settingsSection === 'appearance' ? 'page' : undefined}><SunMoon size={14} />外观</button>
        <button className={settingsSection === 'models' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('models')} aria-current={settingsSection === 'models' ? 'page' : undefined}><Bot size={14} />AI 模型</button>
        <button className={settingsSection === 'export' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('export')} aria-current={settingsSection === 'export' ? 'page' : undefined}><Download size={14} />图片导出</button>
        <button className={settingsSection === 'storage' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('storage')} aria-current={settingsSection === 'storage' ? 'page' : undefined}><Folder size={14} />图库与存储</button>
        <button className={settingsSection === 'tasks' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('tasks')} aria-current={settingsSection === 'tasks' ? 'page' : undefined}><Clock3 size={14} />任务与重试</button>
        <button className={settingsSection === 'shortcuts' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('shortcuts')} aria-current={settingsSection === 'shortcuts' ? 'page' : undefined}><Command size={14} />快捷键</button>
        <button className={settingsSection === 'privacy' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('privacy')} aria-current={settingsSection === 'privacy' ? 'page' : undefined}><ShieldCheck size={14} />隐私与安全</button>
        <button className={settingsSection === 'mcp' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('mcp')} aria-current={settingsSection === 'mcp' ? 'page' : undefined}><Plug size={14} />MCP</button>
        <button className={settingsSection === 'diagnostics' ? 'is-active' : ''} type="button" onClick={() => setSettingsSection('diagnostics')} aria-current={settingsSection === 'diagnostics' ? 'page' : undefined}><ShieldCheck size={14} />诊断与维护</button>
      </aside>
      <main className="settings-content" ref={settingsContentRef}>
        {settingsSection === 'workflow' && <FileWorkflowEditor scope={{ folderId: null, albumId: null }} folders={[]} scopeName="全局默认流程" />}
        {settingsSection === 'appearance' && <>
          <section className="settings-section storage-section"><div className="settings-heading"><h2>界面主题</h2></div><div className="storage-options appearance-options" aria-label="界面主题">{([['system', '跟随系统'], ['dark', '深色'], ['light', '浅色']] as const).map(([value, label]) => <label className={theme === value ? 'is-selected' : ''} key={value}><input type="radio" name="theme" checked={theme === value} onChange={() => void saveTheme(value)} /><span><strong>{label}</strong></span></label>)}</div></section>
          <section className="settings-section storage-section"><div className="settings-heading"><h2>界面语言</h2></div><div className="storage-options appearance-options" aria-label="界面语言">{([['zh-CN', '简体中文'], ['en-US', 'English']] as const).map(([value, label]) => <label className={locale === value ? 'is-selected' : ''} key={value}><input type="radio" name="locale" checked={locale === value} onChange={() => void saveLocale(value)} /><span><strong>{label}</strong></span></label>)}</div></section>
          <section className="settings-section storage-section"><div className="settings-heading"><h2>图库</h2></div><div className="storage-options appearance-options"><label className={centerFileNames ? 'is-selected' : ''}><input type="checkbox" checked={centerFileNames} onChange={(event) => saveFileNameAlignment(event.target.checked)} /><span><strong>文件名居中</strong></span></label></div></section>
        </>}
        {settingsSection === 'models' && <>
        <section className="provider-layout">
          <div className="provider-list">
            <div className="provider-list-head"><div><strong>已配置服务</strong><span>{profiles.length}</span></div><div className="provider-add-actions"><button className="secondary-action compact" type="button" disabled={busy !== null} onClick={() => { setForm({ ...emptyProviderForm, name: 'ACE Nano Banana', kind: 'acedata-nano-banana', purpose: 'generation', baseUrl: 'https://api.acedata.cloud', modelId: 'nano-banana-pro' }); setCustomHeadersText('{}'); setProviderDeleteCandidate(null); setMessage(''); providerNameRef.current?.focus(); }}><Plus size={14} />ACE Nano Banana</button><button className="primary-action compact" type="button" disabled={busy !== null} onClick={() => { setForm({ ...emptyProviderForm }); setCustomHeadersText('{}'); setProviderDeleteCandidate(null); setMessage(''); providerNameRef.current?.focus(); }}><Plus size={14} />添加服务</button></div></div>
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
              <label><span>用途</span><select value={form.purpose} onChange={(event) => patchForm('purpose', event.target.value as SaveProviderProfileInput['purpose'])}><option value="vision" disabled={form.kind === 'acedata-nano-banana'}>视觉分析模型</option><option value="generation">图片生成模型</option></select></label>
              <label><span>接口类型</span><select value={form.kind} onChange={(event) => { const kind = event.target.value as SaveProviderProfileInput['kind']; patchForm('kind', kind); if (kind === 'acedata-nano-banana') { setForm((current) => ({ ...current, kind, purpose: 'generation', baseUrl: current.baseUrl || 'https://api.acedata.cloud', modelId: current.modelId || 'nano-banana-pro' })); } }}><option value="openai-compatible">OpenAI Compatible</option><option value="nanobanana-compatible">NanoBanana Compatible</option><option value="acedata-nano-banana">ACE Data · Nano Banana</option></select></label>
            </div>
            <label><span>配置名称</span><input ref={providerNameRef} required maxLength={80} placeholder="例如：视觉分析 · 主服务" value={form.name} onChange={(event) => patchForm('name', event.target.value)} /></label>
            <label><span>Base URL</span><input required type="url" placeholder={form.kind === 'acedata-nano-banana' ? 'https://api.acedata.cloud' : 'https://api.example.com/v1'} value={form.baseUrl} onChange={(event) => patchForm('baseUrl', event.target.value)} /><small>{form.kind === 'acedata-nano-banana' ? 'ACE Data Nano Banana 专用接口；程序会调用 /nano-banana/images。' : '远程地址必须使用 HTTPS；本地开发服务可使用 localhost HTTP。'}</small></label>
            <label><span>Model ID</span><input required placeholder="模型标识" value={form.modelId} onChange={(event) => patchForm('modelId', event.target.value)} /></label>
            <div className="form-grid two-columns">
              <label><span>请求超时</span><select aria-label="模型请求超时" value={form.requestTimeoutMs} onChange={(event) => patchForm('requestTimeoutMs', Number(event.target.value))}><option value={30_000}>30 秒</option><option value={60_000}>60 秒</option><option value={120_000}>2 分钟</option><option value={300_000}>5 分钟</option><option value={600_000}>10 分钟</option></select></label>
              <label><span>自动重试</span><select aria-label="模型自动重试次数" value={form.retryCount} onChange={(event) => patchForm('retryCount', Number(event.target.value))}><option value={0}>不重试</option><option value={1}>1 次</option><option value={2}>2 次</option><option value={3}>3 次</option><option value={5}>5 次</option></select><small>仅针对限流、网关和服务暂不可用；取消任务会中断等待。</small></label>
            </div>
            <label><span>自定义请求头</span><textarea aria-label="模型自定义请求头" rows={4} spellCheck={false} value={customHeadersText} onChange={(event) => { setCustomHeadersText(event.target.value); setMessage(''); }} /><small>使用 JSON 对象；认证、Cookie、Host、来源及传输层请求头不可覆盖。敏感凭据请只填写 API Key。</small></label>
            <label><span>API Key</span><div className="secret-input"><KeyRound size={14} /><input type="password" autoComplete="off" placeholder={form.id ? '留空以保留已保存凭据' : '输入服务密钥'} value={form.apiKey ?? ''} onChange={(event) => patchForm('apiKey', event.target.value)} /></div><small>密钥保存在应用配置中，不写入图库数据库、日志或导出清单；可随配置迁移到其他设备。</small></label>
            <label className="enabled-row"><input type="checkbox" checked={form.enabled} onChange={(event) => patchForm('enabled', event.target.checked)} /><span>启用此配置</span></label>
            <label className="enabled-row"><input type="checkbox" disabled={!form.enabled} checked={form.enabled && Boolean(form.isDefault)} onChange={(event) => patchForm('isDefault', event.target.checked)} /><span>设为{form.purpose === 'vision' ? '视觉分析' : '图片生成'}默认配置</span></label>
            <div className="form-feedback" role="status">{message}</div>
            <div className="form-actions">{form.id && <button className="danger-action compact" type="button" disabled={busy !== null} onClick={() => void deleteProvider()}>{providerDeleteCandidate === form.id ? '确认删除' : '删除配置'}</button>}<button className="secondary-action" type="button" disabled={busy !== null} onClick={() => void testConnection()}>{busy === 'test' ? '测试中…' : '测试连接'}</button><button className="primary-action compact" type="submit" disabled={busy !== null}>{busy === 'save' ? '保存中…' : '保存配置'}</button></div>
          </form>
        </section>
        </>}
        {settingsSection === 'export' && <section className="settings-section export-presets-section">
          <div className="settings-heading"><div><h2>导出预设</h2><p>原格式导出不会重新编码。</p></div></div>
          <div className="preset-row"><input aria-label="导出预设名称" placeholder="例如：客户交付" value={presetName} onChange={(event) => { setPresetName(event.target.value); setPresetMessage(''); }} /><select aria-label="导出格式" value={presetFormat} onChange={(event) => setPresetFormat(event.target.value as ExportPreset['format'])}><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="original">原格式</option></select><input aria-label="JPEG 质量" type="number" min="1" max="100" disabled={presetFormat !== 'jpeg'} value={presetQuality} onChange={(event) => setPresetQuality(Number(event.target.value))} /><select aria-label="导出尺寸" value={presetMaxDimension ?? ''} onChange={(event) => setPresetMaxDimension(event.target.value ? Number(event.target.value) : null)}><option value="">原始尺寸</option><option value="2048">长边 2048px</option><option value="3840">长边 3840px</option><option value="6000">长边 6000px</option></select><button className="primary-action compact" type="button" disabled={!presetName.trim()} onClick={async () => { try { const saved = await window.desktopApi.saveExportPreset({ name: presetName.trim(), format: presetFormat, quality: presetQuality, maxDimension: presetMaxDimension, conflictPolicy: 'auto-rename', namingPattern: '{name}_{version}' }); setPresets((current) => { const next = [...current.filter((item) => item.id !== saved.id), saved]; onExportPresetsChange(next); return next; }); setPresetName(''); setPresetMessage('预设已保存'); } catch { setPresetMessage('名称已存在或保存失败'); } }}>保存预设</button></div>
          <div className="preset-list">{presets.length === 0 ? <small>暂无导出预设</small> : presets.map((preset) => <div className="preset-item" key={preset.id}><span><strong>{preset.name}</strong><small>{preset.format === 'original' ? '原格式' : preset.format.toUpperCase()}{preset.format === 'jpeg' ? ` · 质量 ${preset.quality}` : ''}{preset.maxDimension ? ` · 长边 ${preset.maxDimension}px` : ''} · {preset.conflictPolicy === 'skip' ? '跳过同名' : '自动编号'}</small></span><button type="button" aria-label={`删除导出预设 ${preset.name}`} onClick={async () => { await window.desktopApi.deleteExportPreset(preset.id); setPresets((current) => { const next = current.filter((item) => item.id !== preset.id); onExportPresetsChange(next); return next; }); }}>删除</button></div>)}</div>
          {presetMessage && <div className="form-feedback" role="status">{presetMessage}</div>}
        </section>}
        {settingsSection === 'storage' && <>
        <section className="settings-section storage-section">
          <div className="settings-heading"><div><h2>生成结果存储</h2><p>仅作用于新任务，不会覆盖原图。</p></div></div>
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
          <div className="settings-heading"><div><h2>图库备份</h2><p>完整备份包含数据库和受管生成结果，不包含 API Key。</p></div></div>
          <div className="cache-actions"><button className="secondary-action" type="button" disabled={backupBusy || libraryBackupBusy || backupVerifyBusy || restoreBusy} onClick={() => void backupDatabase()}>{backupBusy ? '备份中…' : '仅备份数据库'}</button><button className="secondary-action" type="button" disabled={backupBusy || libraryBackupBusy || backupVerifyBusy || restoreBusy} onClick={() => void backupCompleteLibrary()}>{libraryBackupBusy ? '备份中…' : '完整图库备份'}</button><button className="secondary-action" type="button" disabled={backupBusy || libraryBackupBusy || backupVerifyBusy || restoreBusy} onClick={() => void verifyCompleteLibraryBackup()}>{backupVerifyBusy ? '验证中…' : '验证备份包'}</button><button className="secondary-action" type="button" disabled={backupBusy || libraryBackupBusy || backupVerifyBusy || restoreBusy} onClick={() => void restoreCompleteLibraryBackup()}>{restoreBusy ? '准备恢复…' : '从完整备份恢复'}</button><span role="status">{backupMessage || '恢复会保留当前图库副本；原图与便携结果不在备份包内。'}</span></div>
        </section>
        </>}
        {settingsSection === 'tasks' && <section className="settings-section settings-info-section">
          <div className="settings-heading"><h2>队列执行</h2></div>
          <div className="settings-info-grid"><article><strong>并发策略</strong><span>图片分析与生成按队列顺序执行，等待中的任务可在任务中心调整。</span></article><article><strong>失败恢复</strong><span>失败任务保留错误状态和重试次数，不会覆盖已完成版本。</span></article><article><strong>取消边界</strong><span>取消只作用于尚未提交结果的任务，已落盘版本继续保留。</span></article></div>
        </section>}
        {settingsSection === 'shortcuts' && <section className="settings-section settings-info-section">
          <div className="settings-heading"><h2>快捷键</h2></div>
          <div className="shortcut-list"><span><kbd>⌘ / Ctrl</kbd><strong>+</strong><kbd>A</kbd><em>选择当前列表全部照片</em></span><span><kbd>0–5</kbd><em>设置选中照片星级</em></span><span><kbd>6–9</kbd><em>设置红、黄、绿、蓝颜色标签</em></span><span><kbd>Shift</kbd><strong>+</strong><em>范围选择</em></span><span><kbd>⌘ / Ctrl</kbd><strong>+</strong><em>点击追加选择</em></span></div>
        </section>}
        {settingsSection === 'privacy' && <section className="settings-section settings-info-section">
          <div className="settings-heading"><div><h2>数据边界</h2><p>图库保存在本机。执行 AI 任务时，图片会发送至所选模型服务。</p></div></div>
          <div className="settings-info-grid"><article><strong>凭据</strong><span>API Key 保存在应用配置中，不写入 SQLite、manifest、日志或诊断摘要，可随配置迁移。</span></article><article><strong>图片上传</strong><span>分析和生成使用缓存预览图发送，任务完成后服务端响应不会写入日志。</span></article><article><strong>诊断</strong><span>诊断摘要只包含版本、数量和缓存统计，不包含路径、密钥或图片内容。</span></article></div>
        </section>}
        {settingsSection === 'mcp' && <section className="settings-section settings-info-section">
          <div className="settings-heading"><div><h2>外部 MCP</h2><p>让外部 Agent 通过 MCP 调用本应用的图库、任务和修图能力。</p></div></div>
          <label className="enabled-row"><input type="checkbox" aria-label="开启 MCP 服务" checked={mcp?.enabled ?? false} disabled={mcpBusy || !mcp} onChange={(event) => {
            const enabled = event.target.checked; const previous = mcp; setMcpBusy(true); setMcpMessage('');
            void window.desktopApi.setMcpEnabled(enabled).then(setMcp).catch((error: unknown) => { setMcp(previous); setMcpMessage(error instanceof Error ? error.message : 'MCP 设置失败'); }).finally(() => setMcpBusy(false));
          }} /><span><strong>开启 MCP 服务</strong><small>仅监听本机地址，关闭后外部 Agent 无法连接。</small></span></label>
          {mcp?.enabled && <div className="mcp-connection-card"><span><strong>连接地址</strong><code>{mcp.url}</code></span><button className="secondary-action compact" type="button" onClick={() => { void navigator.clipboard.writeText(JSON.stringify({ mcpServers: { PhotoAllIsAI: { url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } }, null, 2)).then(() => setMcpMessage('连接配置已复制')).catch(() => setMcpMessage('复制失败，请检查剪贴板权限')); }}><Copy size={13} />复制连接配置</button></div>}
          <div className="form-feedback" role="status">{mcpMessage || (mcp?.enabled ? `${mcp.tools} 个工具已开放` : 'MCP 当前关闭')}</div>
        </section>}
        {settingsSection === 'diagnostics' && <section className="settings-section diagnostics-section">
          <div className="settings-heading"><div><h2>诊断摘要</h2><p>仅包含运行统计，不包含路径、密钥、图片内容或模型响应。</p></div></div>
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

function TaskCenterPage({ onCatalogChanged, onOpenViewer: openViewer, photos: providedPhotos }: { onCatalogChanged: () => Promise<void>; onOpenViewer: OpenTaskViewer; photos: Photo[] }): React.JSX.Element {
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
  const onOpenViewer: OpenTaskViewer = (assetId, assetIds, options) => openViewer(assetId, assetIds ?? taskBatches.find((batch) => batch.tasks.some((task) => task.assetId === assetId))?.tasks.flatMap((task) => task.assetId ? [task.assetId] : []), options ?? { target: 'latest-ai' });
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
            <span className="task-kind"><button className="task-member-preview task-table-preview" data-label-color={photos.find((photo) => photo.id === task.assetId)?.labelColor ?? undefined} type="button" disabled={!photos.find((photo) => photo.id === task.assetId)} onClick={() => { if (task.assetId) onOpenViewer(task.assetId, batch.tasks.flatMap((item) => item.assetId ? [item.assetId] : [])); }} aria-label={`预览 ${taskImageName(task, photos)}`}>{(photos.find((photo) => photo.id === task.assetId)?.thumbnailSrc || photos.find((photo) => photo.id === task.assetId)?.src) ? <img className="task-item-thumbnail" src={photos.find((photo) => photo.id === task.assetId)!.thumbnailSrc || photos.find((photo) => photo.id === task.assetId)!.src} alt={taskImageName(task, photos)} /> : <TaskKindIcon kind={task.kind} />}</button><span><strong title={taskImageName(task, photos)}>{taskImageName(task, photos)}</strong><small>{taskLabels[task.kind]}</small></span></span>
            <span className="task-scope">{taskScope(task)}</span>
            <span className={`task-state state-${task.status}`}>{taskStage(task)}</span>
            <span>{task.attempt + 1}</span>
            <time dateTime={new Date(task.updatedAt).toISOString()}>{formatTaskTime(task.updatedAt)}</time>
            <span className="task-row-actions">
              {report && <IconButton label={reportOpen ? '收起导出报告' : '查看导出报告'} active={reportOpen} pressed={reportOpen} onClick={() => setExpandedExportTaskId(reportOpen ? null : task.id)}>{reportOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</IconButton>}
            </span>
          </div>
          {task.status === 'failed' && (task.kind === 'analysis' || task.kind === 'collection-analysis') && <AnalysisFailure code={task.errorCode} taskId={task.id} className="task-analysis-failure" />}
          <TaskAnalysisResult task={task} />
          <TaskOutput task={task} photos={photos} batchTasks={batch.tasks} onOpenViewer={onOpenViewer} />
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

function formatTaskTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatTaskDuration(startedAt: number, endedAt: number): string {
  const seconds = Math.max(0, endedAt - startedAt) / 1_000;
  if (seconds < 1) return `${Math.round(seconds * 1_000)} 毫秒`;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes} 分 ${remainingSeconds} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
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
          <div className="template-editor-head"><div><strong>{form.id ? '编辑模板' : '创建模板'}</strong></div><div className="template-editor-head-actions">{form.id && <button className="secondary-action compact" type="button" onClick={() => setPreviewTemplate(templateItems.find((template) => template.id === form.id) ?? null)}><Maximize2 size={13} />预览模板</button>}</div></div>
          <label><span>模板名称</span><input required maxLength={120} value={form.name} placeholder="例如：自然人像 · 清洁背景" onChange={(event) => patchTemplate('name', event.target.value)} /></label>
          <div className="form-grid two-columns"><label><span>分类</span><select value={form.category} onChange={(event) => patchTemplate('category', event.target.value)}><option>人像</option><option>风光</option><option>商品</option><option>建筑</option><option>其他</option></select></label><label><span>示例图片</span><select value={form.exampleId} onChange={(event) => patchTemplate('exampleId', event.target.value as SavePromptTemplateInput['exampleId'])}><option value="portrait">人像示例</option><option value="street">街拍示例</option><option value="coast">海岸示例</option><option value="none">不使用示例</option></select></label></div>
          <label><span>简短描述</span><input maxLength={2_000} value={form.description} placeholder="说明适用场景和效果" onChange={(event) => patchTemplate('description', event.target.value)} /></label>
          <label className="template-body-field"><span>模板正文</span><textarea required value={form.body} onChange={(event) => patchTemplate('body', event.target.value)} /></label>
          <details className="template-variable-disclosure"><summary>可用变量</summary><div className="template-variables">{['analysis.summary', 'analysis.generative_actions', 'catalog.subjects', 'user_instruction', 'preservation_rules'].map((variable) => <code key={variable}>{`{{${variable}}}`}</code>)}</div></details>
          <div className="template-editor-footer"><span role="status">{message}</span>{form.id && <button className="danger-action compact" type="button" onClick={() => void archiveTemplate()}>{archiveCandidate === form.id ? '确认归档' : '归档模板'}</button>}<button className="primary-action compact" type="submit">{form.id ? '保存新版本' : '创建模板'}</button></div>
        </form>
      </div>
      {previewTemplate && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewTemplate(null); }}><section className="template-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="template-preview-title"><header><div><span className="dialog-icon"><WandSparkles size={16} /></span><div><h2 id="template-preview-title">{previewTemplate.name}</h2><p>{previewTemplate.category} · 版本 {previewTemplate.version}</p></div></div><IconButton label="关闭模板预览" onClick={() => setPreviewTemplate(null)}><X size={15} /></IconButton></header><div className="template-preview-content">{previewTemplate.exampleId === 'none' ? <div className="template-preview-placeholder"><Image size={28} /><span>未设置示例图片</span></div> : <img className="template-preview-hero" src={`./demo/${previewTemplate.exampleId}.jpg`} alt={`${previewTemplate.name} 示例图片`} />}<div className="template-preview-meta"><span className="template-preview-category">{previewTemplate.category}</span><span>版本 {previewTemplate.version}</span></div><p className="template-preview-description">{previewTemplate.description || '暂无描述'}</p><div className="template-preview-body"><strong>模板正文</strong><pre>{previewTemplate.body}</pre></div></div><footer><button className="quiet-button" type="button" onClick={() => setPreviewTemplate(null)}>关闭</button><button className="primary-action compact" type="button" onClick={() => { setForm({ id: previewTemplate.id, name: previewTemplate.name, description: previewTemplate.description, category: previewTemplate.category, body: previewTemplate.body, exampleId: previewTemplate.exampleId }); setPreviewTemplate(null); }}>编辑模板</button></footer></section></div>}
    </div>
  );
}

function InlinePhotoViewer({ workspace, photo, items, onPhotoChange, onClose, resultId, options, onSelectResult, onRemoveResult }: { workspace: LibraryWorkspaceProps; photo: Photo; items: Photo[]; onPhotoChange: (photo: Photo) => void; onClose: () => void; resultId: string | undefined; options: ViewerOpenOptions; onSelectResult: (result: GenerationResult) => void; onRemoveResult: (resultId: string) => void }): React.JSX.Element {
  const panelRef = useRef<HTMLElement>(null);
  const displayItems = items.map((item) => photo.workflow && item.workflow?.id === photo.workflow.id ? photo : item);
  const [selection, setSelection] = useState<SelectionState>(() => ({ selectedIds: new Set([photo.id]), anchorId: photo.id, focusId: photo.id }));
  const itemIdsKey = JSON.stringify(items.map((item) => item.id));
  const selectionPhotoId = useRef(photo.id);
  selectionPhotoId.current = photo.id;
  useEffect(() => { const id = selectionPhotoId.current; setSelection({ selectedIds: new Set([id]), anchorId: id, focusId: id }); }, [itemIdsKey]);
  useEffect(() => { panelRef.current?.querySelector<HTMLElement>('.canvas-wrap')?.focus({ preventScroll: true }); }, [resultId]);
  useEffect(() => {
    if (!options.results?.length) return;
    const navigate = (event: KeyboardEvent) => {
      if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [role="slider"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const index = options.results!.findIndex((result) => result.id === resultId);
      const next = options.results![clamp(index + (event.key === 'ArrowLeft' ? -1 : 1), 0, options.results!.length - 1)];
      if (next) onSelectResult(next);
    };
    window.addEventListener('keydown', navigate, true);
    return () => window.removeEventListener('keydown', navigate, true);
  }, [options.results, resultId, onSelectResult]);
  return <section className="inline-photo-viewer" aria-label="看图" ref={panelRef} onKeyDown={(event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[role="menu"]') || panelRef.current?.querySelector('[role="dialog"], .tag-editor-popover')) return;
    if (document.fullscreenElement) { event.stopPropagation(); return; }
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }}><LibraryWorkspace {...workspace} active view="viewer" availablePhotos={displayItems} selectedAssetId={photo.id} selection={selection} onSelectionChange={setSelection} onSelectedAssetChange={(id) => { const next = displayItems.find((item) => item.id === id); if (next) onPhotoChange(next); }} onWorkflowStageChange={(next) => { setSelection((current) => ({ selectedIds: new Set([...current.selectedIds].map((id) => id === photo.id ? next.id : id)), anchorId: current.anchorId === photo.id ? next.id : current.anchorId, focusId: current.focusId === photo.id ? next.id : current.focusId })); onPhotoChange(next); }} totalCount={items.length} hasMore={false} onCloseViewer={onClose} initialResultId={resultId} initialVersionTarget={options.target} resultSequence={options.results} onSelectViewerResult={onSelectResult} onRemoveViewerResult={onRemoveResult} /></section>;
}

function QuickPhotoViewer({ session, photo, onPhotoChange, onClose }: { session: QuickViewSession; photo: Photo; onPhotoChange: (photo: Photo) => void; onClose: () => void }): React.JSX.Element {
  const items = useMemo(() => mapCatalogAssets(session.items).map((item) => ({ ...item, temporary: true })), [session]);
  const [selection, setSelection] = useState<SelectionState>(() => ({ selectedIds: new Set([photo.id]), focusId: photo.id, anchorId: photo.id }));
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const [visibleIds, setVisibleIds] = useState<string[] | null>(null);
  const panel = useRef<HTMLElement>(null);
  const [notice, setNotice] = useTransientNotice();
  const [menu, setMenu] = useState<{ x: number; y: number; photo: Photo; filmstrip?: FilmstripMenuOptions | undefined } | null>(null);
  useEffect(() => { panel.current?.querySelector<HTMLElement>('.canvas-wrap')?.focus(); }, []);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key, true); window.removeEventListener('blur', close); };
  }, [menu]);
  const openMenu = (event: React.MouseEvent, item: Photo, filmstrip?: FilmstripMenuOptions) => {
    event.preventDefault();
    setMenu({ x: Math.max(4, Math.min(event.clientX, window.innerWidth - 220)), y: Math.max(4, Math.min(event.clientY, window.innerHeight - (filmstrip ? 260 : 150))), photo: item, filmstrip });
  };
  const run = (action: () => Promise<unknown>) => {
    setMenu(null);
    void action().catch((error: unknown) => setNotice(error instanceof Error ? error.message : '文件操作失败'));
  };
  return <section className="inline-photo-viewer" aria-label="临时看图" ref={panel} onKeyDown={(event) => {
    if (event.defaultPrevented || document.querySelector('[role="dialog"], [role="menu"]') || (event.target instanceof Element && event.target.closest('input, textarea, select'))) return;
    if (event.key === 'Escape') { if (document.fullscreenElement) { event.stopPropagation(); return; } event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const visible = items.filter((item) => !visibleIds || visibleIds.includes(item.id));
      const index = visible.findIndex((item) => item.id === photo.id);
      const next = visible[clamp(index < 0 ? (event.key === 'ArrowRight' ? 0 : visible.length - 1) : index + (event.key === 'ArrowRight' ? 1 : -1), 0, visible.length - 1)];
      if (next) { onPhotoChange(next); setSelection({ selectedIds: new Set([next.id]), focusId: next.id, anchorId: next.id }); }
    }
  }}>
    <div className="quick-view-workspace">
      <Viewer photo={photo} results={[]} isDemo={false} trackedExportNotice="" onReview={async () => undefined} onOpenContextMenu={(event) => openMenu(event, photo)} onClose={onClose} onToolbarHostChange={setToolbarHost} />
      <Filmstrip items={items} selected={photo} selection={selection} onSelect={(next, intent) => { setSelection((current) => updateSelection(current, visibleIds ?? items.map((item) => item.id), next.id, intent)); onPhotoChange(next); }} onSelectionChange={setSelection} onFocusPhoto={onPhotoChange} collectionName={session.directory.split(/[/\\\\]/u).at(-1) ?? ''} toolbarHost={toolbarHost} totalCount={items.length} favoriteOnly={false} onFavoriteOnlyChange={() => undefined} sortBy="fileName" onSortByChange={() => undefined} hasMore={false} loading={false} onLoadMore={() => undefined} onVisibleIdsChange={setVisibleIds} onOpenContextMenu={openMenu} />
      {menu && <ContextMenuSurface className="folder-context-menu" role="menu" aria-label="图片文件菜单" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
        <button role="menuitem" type="button" onClick={() => run(() => window.desktopApi.openAssetExternally(menu.photo.id))}><ExternalLink size={14} />用默认应用打开</button>
        <button role="menuitem" type="button" onClick={() => run(async () => { if (!await window.desktopApi.revealCatalogAsset(menu.photo.id)) throw new Error('图片文件不可访问'); })}><FolderOpen size={14} />{FILE_MANAGER_LABEL}</button>
        <button role="menuitem" type="button" onClick={() => run(async () => { const details = await window.desktopApi.getFileDetails(menu.photo.id); await navigator.clipboard.writeText(details.path); })}><Copy size={14} />复制文件路径</button>
        {menu.filmstrip && <FilmstripMenu options={menu.filmstrip} onClose={() => setMenu(null)} />}
      </ContextMenuSurface>}
      {notice && <div role="status" className="operation-toast">{notice}<button aria-label="关闭提示" type="button" onClick={() => setNotice('')}><X size={13} /></button></div>}
    </div>
  </section>;
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
  const [navigationNotice, setNavigationNotice] = useTransientNotice();
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
  const [quickSession, setQuickSession] = useState<QuickViewSession | null>(null);
  const [quickPhoto, setQuickPhoto] = useState<Photo | null>(null);
  const acceptQuickSession = useCallback((session: QuickViewSession) => {
    const photo = mapCatalogAssets(session.items).find((item) => item.id === session.selectedId);
    if (!photo) return;
    setQuickSession(session);
    setQuickPhoto({ ...photo, temporary: true });
    setViewerPhoto(null);
    setTaskDrawerOpen(false);
  }, []);
  useEffect(() => {
    const unsubscribe = window.desktopApi.onOpenImages(acceptQuickSession);
    void window.desktopApi.takePendingOpenImages().then((session) => { if (session) acceptQuickSession(session); }).catch(() => undefined);
    return unsubscribe;
  }, [acceptQuickSession]);
  const [viewerPhotos, setViewerPhotos] = useState<Photo[]>([]);
  const [viewerResultId, setViewerResultId] = useState<string | undefined>(undefined);
  const [viewerOptions, setViewerOptions] = useState<ViewerOpenOptions>({});
  const viewerCatalogScope = useRef<string | null>(null);
  const viewerAssetsRef = useRef<string[]>([]);
  useEffect(() => {
    viewerAssetsRef.current = viewerPhoto ? [...new Set([...viewerPhotos.map((photo) => photo.id), viewerPhoto.id])] : [];
  }, [viewerPhoto, viewerPhotos]);
  useEffect(() => {
    const ids = viewerAssetsRef.current;
    if (ids.length === 0) return;
    let active = true;
    // Viewer items may belong to a task or have left the current library filter.
    void (async () => {
      const updatedPhotos: Photo[] = [];
      for (let offset = 0; offset < ids.length; offset += 500) {
        const page = await window.desktopApi.listCatalogAssetPage({ assetIds: ids.slice(offset, offset + 500), limit: 500 });
        if (!active) return;
        updatedPhotos.push(...mapCatalogAssets(page.items));
      }
      const byId = new Map(updatedPhotos.map((photo) => [photo.id, photo]));
      const workflows = new Map(catalogPhotos.filter((photo) => photo.workflow).map((photo) => [photo.workflow!.id, photo]));
      const refresh = (photo: Photo): Photo => {
        const workflow = photo.workflow ? workflows.get(photo.workflow.id)?.workflow ?? photo.workflow : undefined;
        return { ...(byId.get(photo.id) ?? photo), ...(workflow ? { workflow } : {}) };
      };
      setViewerPhotos((current) => current.map(refresh));
      setViewerPhoto((current) => current ? refresh(current) : null);
    })().catch(() => undefined);
    return () => { active = false; };
  }, [catalogPhotos]);
  const viewerRequest = useRef(0);
  const openViewerRef = useRef<(assetId: string, assetIds?: string[]) => void>(() => undefined);
  const viewerOrigin = useRef<{ focus: HTMLElement | null; drawerOpen: boolean; scroll: Array<{ element: HTMLElement; top: number; left: number }> } | null>(null);
  const closeViewer = useCallback(() => {
    viewerRequest.current += 1;
    viewerCatalogScope.current = null;
    setViewerPhoto(null);
    setViewerPhotos([]);
    setViewerResultId(undefined);
    setViewerPreloading(false);
    const origin = viewerOrigin.current;
    viewerOrigin.current = null;
    if (origin) {
      setTaskDrawerOpen(origin.drawerOpen);
      window.requestAnimationFrame(() => {
        for (const { element, top, left } of origin.scroll) {
          if (element.isConnected) element.scrollTo(left, top);
        }
        if (origin.focus?.isConnected) origin.focus.focus({ preventScroll: true });
      });
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
      if (document.fullscreenElement) return;
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
  const [photoFilters, setPhotoFilters] = useState<PhotoFilters>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('photoallisai.catalog-group-order') ?? 'null');
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        const groupOrder = Object.fromEntries(Object.entries(saved).filter(([, order]) => order === 'asc' || order === 'desc')) as PhotoFilters['groupOrder'];
        return { ...emptyPhotoFilters, groupOrder };
      }
    } catch { /* restricted storage */ }
    return emptyPhotoFilters;
  });
  useEffect(() => {
    try { localStorage.setItem('photoallisai.catalog-group-order', JSON.stringify(photoFilters.groupOrder)); } catch { /* restricted storage */ }
  }, [photoFilters.groupOrder]);
  const catalogFilterInput = useMemo(() => ({ minimumRating: photoFilters.minimumRating, ratingOperator: photoFilters.ratingOperator, flags: photoFilters.flags, colors: photoFilters.colors }), [photoFilters.minimumRating, photoFilters.ratingOperator, photoFilters.flags, photoFilters.colors]);
  const [sortBy, setSortBy] = useState<CatalogSort>('fileName');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc' | undefined>('asc');
  const catalogRequest = useRef(0);
  const catalogPagePending = useRef(false);

  useEffect(() => {
    applyCatalogFileNameAlignment(catalogFileNameCentered());
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
      setSortDirection(session.library.sortDirection);
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
      library: { selectedFolderId, selectedAlbumId, selectedSmartCollection, selectedTagId, selectedAssetId, favoriteOnly, sortBy, ...(sortDirection ? { sortDirection } : {}), searchQuery: searchDraft.trim() }
    };
    const timeout = window.setTimeout(() => {
      void window.desktopApi.saveWorkspaceSession(session).catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timeout);
  }, [activeTab, favoriteOnly, openTabs, searchDraft, selectedAlbumId, selectedAssetId, selectedFolderId, selectedSmartCollection, selectedTagId, sessionReady, sortBy, sortDirection]);

  const refreshCatalog = useCallback(async (folderId: string | null = selectedFolderId) => {
    const request = ++catalogRequest.current;
    catalogPagePending.current = false;
    setLoadingMore(true);
    try {
      const [page, folders, tags, albums, smartCollections] = await Promise.all([
        window.desktopApi.listCatalogAssetPage({ folderId, tagId: selectedTagId, albumId: selectedAlbumId, smartCollection: selectedSmartCollection, ...catalogFilterInput, favoriteOnly, sortBy, ...(sortDirection ? { sortDirection } : {}), query: searchQuery, cursor: null, limit: 200 }),
        window.desktopApi.listCatalogFolders(),
        window.desktopApi.listCatalogTags(),
        window.desktopApi.listCatalogAlbums(),
        window.desktopApi.listCatalogSmartCollections()
      ]);
      if (request !== catalogRequest.current) return;
      const nextPhotos = mapCatalogAssets(page.items);
      setCatalogPhotos(nextPhotos);
      const scope = JSON.stringify([folderId, selectedAlbumId, selectedSmartCollection, selectedTagId]);
      if (viewerCatalogScope.current !== null && viewerCatalogScope.current !== scope) {
        viewerCatalogScope.current = scope;
        setViewerPhotos(nextPhotos);
        setViewerPhoto((current) => current ? nextPhotos[0] ?? null : null);
        setViewerResultId(undefined);
        setViewerOptions({});
      }
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
    } catch (error) {
      if (request === catalogRequest.current) setNavigationNotice(error instanceof Error ? error.message : '无法加载图库');
    } finally {
      if (request === catalogRequest.current) setLoadingMore(false);
    }
  }, [favoriteOnly, catalogFilterInput, searchQuery, selectedAlbumId, selectedFolderId, selectedSmartCollection, selectedTagId, sortBy, sortDirection, setNavigationNotice]);

  useEffect(() => {
    if (!sessionReady) return;
    void refreshCatalog();
  }, [refreshCatalog, sessionReady]);

  useEffect(() => window.desktopApi.onCatalogChanged(() => { void refreshCatalog(); }), [refreshCatalog]);

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
      else if (command === 'close-workspace') { if (quickPhoto) { setQuickSession(null); setQuickPhoto(null); } else if (viewerPhoto || viewerPreloading) closeViewer(); else closeWorkspaceTab(activeTab); }
      else window.dispatchEvent(new CustomEvent('photoallisai:menu-command', { detail: command }));
    });
    return unsubscribe;
  }, [activeTab, catalogPhotos, catalogReady, catalogTotal, closeViewer, closeWorkspaceTab, importFolders, openWorkspaceTab, refreshCatalog, selectedAssetId, viewerPhoto, viewerPreloading, quickPhoto]);

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
      if (event.key.toLowerCase() === 'w' && (quickPhoto || viewerPhoto || viewerPreloading || activeTab !== 'library')) {
        event.preventDefault();
        if (quickPhoto) { setQuickSession(null); setQuickPhoto(null); } else if (viewerPhoto || viewerPreloading) closeViewer(); else closeWorkspaceTab(activeTab);
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
  }, [activeTab, closeViewer, closeWorkspaceTab, openTabs, viewerPhoto, viewerPreloading, quickPhoto]);

  const loadMoreCatalog = useCallback(async () => {
    if (!nextCursor || loadingMore || catalogPagePending.current) return;
    catalogPagePending.current = true;
    const request = ++catalogRequest.current;
    setLoadingMore(true);
    try {
      const page = await window.desktopApi.listCatalogAssetPage({
        folderId: selectedFolderId,
        tagId: selectedTagId,
        albumId: selectedAlbumId,
        smartCollection: selectedSmartCollection,
        favoriteOnly,
        ...catalogFilterInput,
        sortBy,
        ...(sortDirection ? { sortDirection } : {}),
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
    } catch (error) {
      setNavigationNotice(error instanceof Error ? error.message : '无法继续加载照片');
    } finally {
      catalogPagePending.current = false;
      if (request === catalogRequest.current) setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, selectedFolderId, selectedTagId, selectedAlbumId, selectedSmartCollection, favoriteOnly, catalogFilterInput, sortBy, sortDirection, searchQuery, setNavigationNotice]);

  const isDemo = E2E_DEMO_MODE && catalogReady && catalogTotal === 0 && catalogFolders.length === 0;
  const availablePhotos = useMemo(() => {
    if (catalogReady && !isDemo) return catalogPhotos;
    return photos.filter((photo) => (!searchQuery.trim() || photo.fileName.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()))
      && (photoFilters.minimumRating === null || (photoFilters.ratingOperator === 'eq' ? photo.rating === photoFilters.minimumRating : photoFilters.ratingOperator === 'lte' ? photo.rating <= photoFilters.minimumRating : photo.rating >= photoFilters.minimumRating))
      && (!photoFilters.flags.length || photoFilters.flags.includes(photo.flag ?? 'unflagged'))
      && (!photoFilters.colors.length || (photo.labelColor && photoFilters.colors.includes(photo.labelColor)))
      && (!favoriteOnly || photo.favorite));
  }, [catalogReady, isDemo, catalogPhotos, searchQuery, photoFilters, favoriteOnly]);
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
  const globalFocusPhoto = quickPhoto ?? viewerPhoto ?? availablePhotos.find((photo) => photo.id === sharedSelection.focusId)
    ?? catalogPhotos.find((photo) => photo.id === sharedSelection.focusId)
    ?? availablePhotos.find((photo) => photo.id === selectedAssetId)
    ?? availablePhotos[0];
  const contextSelectedIds = useMemo(() => quickPhoto ? new Set<string>() : viewerPhoto ? new Set([viewerPhoto.id]) : sharedSelection.selectedIds, [quickPhoto, viewerPhoto, sharedSelection.selectedIds]);
  const contextPhotos = useMemo(() => quickPhoto ? [] : viewerPhoto ? [viewerPhoto, ...viewerPhotos.filter((photo) => photo.id !== viewerPhoto.id), ...availablePhotos.filter((photo) => photo.id !== viewerPhoto.id && !viewerPhotos.some((item) => item.id === photo.id))] : availablePhotos, [quickPhoto, viewerPhoto, viewerPhotos, availablePhotos]);
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
    active: !viewerPhoto && !quickPhoto,
    onOpenViewer: (assetId, assetIds) => void openViewer(assetId, assetIds),
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
    filterSearch: searchDraft,
    photoFilters,
    onPhotoFiltersChange: setPhotoFilters,
    sortDirection,
    onSortDirectionChange: setSortDirection,
    onSearchChange: setSearchDraft,
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
  const openViewer = async (assetId: string, assetIds?: string[], options: ViewerOpenOptions = {}) => {
    const request = ++viewerRequest.current;
    const origin = viewerOrigin.current ?? {
      focus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      drawerOpen: taskDrawerOpen,
      scroll: Array.from(document.querySelectorAll<HTMLElement>('.workspace-source-page *'))
        .filter((element) => element.scrollTop > 0 || element.scrollLeft > 0)
        .map((element) => ({ element, top: element.scrollTop, left: element.scrollLeft }))
    };
    setViewerPreloading(true);
    try {
      const ids = [...new Set([...(assetIds ?? availablePhotos.map((item) => item.id)), ...(options.results?.map((result) => result.assetId) ?? [])])];
      if (options.results) {
        const liveResults = (await Promise.all([...new Set(options.results.map((result) => result.assetId))].map((id) => window.desktopApi.listGenerationResults(id)))).flat();
        const liveById = new Map(liveResults.map((result) => [result.id, result]));
        const results = options.results.flatMap((result) => liveById.has(result.id) ? [liveById.get(result.id)!] : []);
        options = { ...options, results, resultId: results.some((result) => result.id === options.resultId) ? options.resultId : results[0]?.id };
      }
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
      viewerCatalogScope.current = JSON.stringify([selectedFolderId, selectedAlbumId, selectedSmartCollection, selectedTagId]);
      setViewerPhotos(ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []));
      setViewerPhoto(photo);
      setViewerResultId(options.resultId);
      setViewerOptions(options);
    } catch {
      if (request === viewerRequest.current) setNavigationNotice('无法读取图片，请检查图库和原文件是否可用。');
    } finally {
      if (request === viewerRequest.current) setViewerPreloading(false);
    }
  };
  openViewerRef.current = (assetId, assetIds) => { void openViewer(assetId, assetIds); };

  const selectViewerResult = (result: GenerationResult) => {
    const next = viewerPhotos.find((photo) => photo.id === result.assetId);
    if (!next) return;
    setViewerPhoto(next);
    setViewerResultId(result.id);
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.inline-photo-viewer .canvas-wrap')?.focus({ preventScroll: true }));
  };
  const removeViewerResult = (resultId: string) => {
    const sequence = viewerOptions.results;
    if (!sequence) return;
    const remaining = sequence.filter((result) => result.id !== resultId);
    setViewerOptions((current) => ({ ...current, results: remaining }));
    const next = remaining[Math.min(sequence.findIndex((result) => result.id === resultId), remaining.length - 1)];
    if (next) selectViewerResult(next);
    else closeViewer();
  };

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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNavigationNotice(message.includes('TARGET_FOLDER_NOT_FOUND') ? '目标文件夹已变化，请刷新图库后重试。' : message.includes('ASSET_HAS_ACTIVE_TASKS') ? '所选照片有正在运行的任务，完成后再移动。' : message.includes('EACCES') || message.includes('EPERM') ? '无法写入目标文件夹，请检查磁盘权限。' : `拖放操作失败：${message.replace(/^Error invoking remote method [^:]+: /u, '').slice(0, 120)}`);
    }
  };

  return (
    <div className="app-shell" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }} onDrop={(event) => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      const paths = window.desktopApi.getDroppedFilePaths([...event.dataTransfer.files]);
      if (paths.length) void window.desktopApi.openImages(paths).then((session) => { if (session) acceptQuickSession(session); }).catch((error: unknown) => setNavigationNotice(error instanceof Error ? error.message : '无法打开图片'));
    }}>
      <AppHeader active={activeTab} openTabs={openTabs} onChange={setActiveTab} onClose={closeWorkspaceTab} onOpen={openWorkspaceTab} onImport={() => void importFolders()} search={searchDraft} onSearchChange={setSearchDraft} />
      {!sessionReady || !catalogReady ? <main className="workspace-loading"><span className="working-pulse" /><span>{sessionReady ? '正在读取图库' : '正在恢复工作区'}</span></main>
        : <div className="global-workspace-shell" style={{ gridTemplateColumns: `${panelVisibility.left ? globalLayout.leftWidth : 0}px ${panelVisibility.left ? 5 : 0}px minmax(0, 1fr) ${panelVisibility.right ? 5 : 0}px ${panelVisibility.right ? globalLayout.rightWidth : 0}px` }}>
              <div className="workspace-side-panel" hidden={!panelVisibility.left}><Sidebar folders={catalogFolders} albums={catalogAlbums} smartCollections={catalogSmartCollections} totalCount={catalogTotal} selectedFolderId={selectedFolderId} selectedAlbumId={selectedAlbumId} selectedSmartCollection={selectedSmartCollection} tags={catalogTags} selectedTagId={selectedTagId} onSelectFolder={workspaceProps.onSelectFolder} onSelectAlbum={workspaceProps.onSelectAlbum} onSelectSmartCollection={workspaceProps.onSelectSmartCollection} onRefreshAlbums={refreshCatalog} onImportFolders={importFolders} onRelinkFolder={relinkFolder} onSynchronizeFolder={synchronizeFolder} onRevealFolder={revealFolder} onUnregisterFolder={unregisterFromNavigation} onMoveFolder={moveFolder} onDropAssets={dropAssetsFromNavigation} onSelectTag={setSelectedTagId} isDemo={isDemo} /></div>
              <div className="workspace-side-splitter" hidden={!panelVisibility.left}><PaneSplitter orientation="vertical" value={globalLayout.leftWidth} minimum={160} maximum={420} label="调整左侧目录栏宽度" onChange={(value) => setGlobalLayout('leftWidth', value)} /></div>
              <div className="workspace-page-stack">
              <div className="workspace-source-page" inert={Boolean(viewerPhoto)} aria-hidden={viewerPhoto ? true : undefined} style={viewerPhoto ? { visibility: 'hidden' } : undefined}>
              {activeTab === 'library' ? <LibraryWorkspace {...workspaceProps} />
                : activeTab === 'batch' || activeTab === 'workflow' ? <AiWorkflowPage photos={availablePhotos} focusId={sharedSelection.focusId} workflowAssetIds={workflowAssetIds} workflowAssetMeta={workflowAssetMeta} tasks={globalTasks} globalRules={workflowRules} onGlobalRulesChange={setWorkflowRules} templateId={workflowTemplateId} onRemoveAsset={removeWorkflowAsset} onMoveAsset={moveWorkflowAsset} onClearAssets={() => { setWorkflowAssetIds([]); setWorkflowAssetMeta({}); }} onOpenTasks={() => openWorkspaceTab('tasks')} onOpenViewer={(assetId, assetIds, options) => void openViewer(assetId, assetIds, options)} onFocusAsset={(id) => setSharedSelection((current) => ({ ...current, focusId: id }))} />
                : activeTab === 'settings' ? <SettingsPage onExportPresetsChange={setExportPresets} />
                  : activeTab === 'tasks' ? <TaskCenterPage onCatalogChanged={refreshCatalog} onOpenViewer={(assetId, assetIds, options) => void openViewer(assetId, assetIds, options)} photos={availablePhotos} />
                    : <TemplatePage />}
              </div>
              {viewerPhoto && <InlinePhotoViewer workspace={workspaceProps} photo={viewerPhoto} items={viewerPhotos} onPhotoChange={(photo) => { setViewerPhoto(photo); setViewerResultId(undefined); }} onClose={closeViewer} resultId={viewerResultId} options={viewerOptions} onSelectResult={selectViewerResult} onRemoveResult={removeViewerResult} />}
              {quickSession && quickPhoto && <QuickPhotoViewer key={quickSession.selectedId} session={quickSession} photo={quickPhoto} onPhotoChange={setQuickPhoto} onClose={() => { setQuickSession(null); setQuickPhoto(null); }} />}
              {viewerPreloading && <div className="viewer-preload-indicator" role="status"><span className="working-pulse" />正在准备预览</div>}
              </div>
              <div className="workspace-side-splitter" hidden={!panelVisibility.right}><PaneSplitter orientation="vertical" value={globalLayout.rightWidth} minimum={240} maximum={520} label="调整右侧 AI 面板宽度" invert onChange={(value) => setGlobalLayout('rightWidth', value)} /></div>
              <div hidden={!panelVisibility.right} className={`workspace-side-panel right-dock-stack${dockLayout.collapsed ? ' is-collapsed' : ''}`}>
                <div className="inspector unified-dock">
                  <div className="inspector-tabs"><button className={dockTab === 'ai' ? 'is-active' : ''} type="button" onClick={() => { setDockTab('ai'); setAgentDockOpen(false); }}><Bot size={14} />AI</button><button className={dockTab === 'agent' ? 'is-active' : ''} type="button" onClick={() => { setDockTab('agent'); setAgentDockOpen(true); }}><Sparkles size={14} />Agent</button><button className={dockTab === 'details' ? 'is-active' : ''} type="button" onClick={() => { setDockTab('details'); setAgentDockOpen(false); }}><Info size={14} />详情</button></div>
                  <div className="inspector-scroll">{dockTab === 'agent' ? <AgentDockPanel selectedIds={contextSelectedIds} photos={contextPhotos} onOpenResult={(result, results, assetIds) => { void openViewer(result.assetId, assetIds, { resultId: result.id, results }); }} onOpenAsset={(assetId, assetIds) => { void openViewer(assetId, assetIds); }} onClose={() => { setDockTab('ai'); setAgentDockOpen(false); }} onCollapse={() => saveDockLayout({ ...dockLayout, collapsed: true })} onMove={() => saveDockLayout({ ...dockLayout, order: ['details', 'agent'] })} /> : dockTab === 'details' && globalFocusPhoto ? <GlobalDetailsPanel photo={globalFocusPhoto} /> : <GlobalAiPanel onOpenBatch={() => openWorkspaceTab('batch')} photo={globalFocusPhoto} selectedIds={contextSelectedIds} isDemo={isDemo} workspaceTab={activeTab} onOpenTemplates={() => openWorkspaceTab('templates')} onAddAssetsToWorkflow={addAssetsToWorkflow} workflowAssetIds={workflowAssetIds} tasks={globalTasks} workflowRules={workflowRules} onWorkflowRulesChange={setWorkflowRules} workflowTemplateId={workflowTemplateId} onWorkflowTemplateChange={setWorkflowTemplateId} />}</div>
                </div>
                {dockLayout.collapsed && <button className="dock-restore" type="button" onClick={() => saveDockLayout({ ...dockLayout, collapsed: false })}>展开 Dock 面板</button>}
              </div>
              {navigationNotice && <div className="operation-toast global-navigation-notice" role="status">{navigationNotice}<button type="button" aria-label="关闭提示" onClick={() => setNavigationNotice('')}><X size={13} /></button></div>}
            </div>}
      <TaskBar panelVisibility={panelVisibility} onTogglePanel={(side) => { panelsBeforeHide.current = null; setPanelVisibility((current) => ({ ...current, [side]: !current[side] })); }} suspended={Boolean(viewerPhoto || quickPhoto)} open={taskDrawerOpen} onToggle={() => setTaskDrawerOpen((value) => !value)} onOpenTaskCenter={() => { setTaskDrawerOpen(false); openWorkspaceTab('tasks'); }} onOpenViewer={(assetId, assetIds, options) => void openViewer(assetId, assetIds, options)} tasks={isDemo ? null : globalTasks} counts={globalTaskCounts} photos={availablePhotos} />
    </div>
  );
}
