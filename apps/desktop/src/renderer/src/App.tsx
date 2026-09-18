import { useEffect, useMemo, useState } from 'react';
import type { CatalogAsset } from '@photoallisai/contracts';
import { selectAll, updateSelection, type SelectionIntent, type SelectionState } from '@photoallisai/domain';
import {
  Aperture,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Columns2,
  Download,
  Folder,
  FolderHeart,
  FolderOpen,
  GalleryHorizontalEnd,
  Grid2X2,
  Image,
  Info,
  Layers3,
  ListFilter,
  Maximize2,
  PanelBottomOpen,
  Pause,
  Play,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Star,
  Tags,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react';

import { photos, type Photo } from './mock-data';

type WorkspaceTab = 'library' | 'templates' | 'tasks' | 'settings';
type CompareMode = 'single' | 'split';

const tabs: { id: WorkspaceTab; label: string; icon: typeof Image }[] = [
  { id: 'library', label: '图库', icon: Image },
  { id: 'templates', label: '提示词模板', icon: WandSparkles },
  { id: 'tasks', label: '任务中心', icon: Clock3 },
  { id: 'settings', label: '设置', icon: Settings }
];

const folders = [
  { name: '2026 人像作品', count: 128, selected: true },
  { name: '城市漫步', count: 84 },
  { name: '海岸与山野', count: 216 },
  { name: '待交付', count: 37 }
];

function mapCatalogAssets(assets: CatalogAsset[]): Photo[] {
  return assets.map((asset) => ({
    id: asset.id,
    fileName: asset.fileName,
    src: asset.previewUrl,
    thumbnailSrc: asset.thumbnailUrl,
    format: asset.format,
    dimensions: `${(asset.sizeBytes / 1_048_576).toFixed(1)} MB`,
    rating: 0
  }));
}

function IconButton({
  label,
  children,
  active = false,
  onClick
}: {
  label: string;
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}): React.JSX.Element {
  return (
    <button
      className={`icon-button${active ? ' is-active' : ''}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function AppTabs({ active, onChange }: { active: WorkspaceTab; onChange: (id: WorkspaceTab) => void }) {
  return (
    <div className="tab-strip" role="tablist" aria-label="工作区">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            className={`workspace-tab${active === tab.id ? ' is-active' : ''}`}
            role="tab"
            aria-selected={active === tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
          >
            <Icon size={14} />
            <span>{tab.label}</span>
            {tab.id !== 'library' && <X className="tab-close" size={12} />}
          </button>
        );
      })}
      <IconButton label="新建工作区">
        <Plus size={15} />
      </IconButton>
    </div>
  );
}

function AppHeader({ active, onChange, onImport }: { active: WorkspaceTab; onChange: (id: WorkspaceTab) => void; onImport: () => void }) {
  return (
    <header className="app-header">
      <div className="titlebar-drag" />
      <div className="brand">
        <Aperture size={18} strokeWidth={1.7} />
        <span>PhotoAllIsAI</span>
      </div>
      <AppTabs active={active} onChange={onChange} />
      <div className="header-actions">
        <button className="search-trigger" type="button">
          <Search size={14} />
          <span>搜索图库</span>
          <kbd>⌘ K</kbd>
        </button>
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

function Sidebar(): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
        <nav aria-label="图库导航">
          <div className="nav-row is-active">
            <GalleryHorizontalEnd size={15} />
            <span>所有照片</span>
            <span className="row-count">12,408</span>
          </div>
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
          {folders.map((folder) => (
            <div className={`nav-row folder-row${folder.selected ? ' is-selected' : ''}`} key={folder.name}>
              <ChevronRight className="disclosure" size={12} />
              <Folder size={15} />
              <span>{folder.name}</span>
              <span className="row-count">{folder.count}</span>
            </div>
          ))}
        </div>

        <div className="sidebar-section">
          <div className="section-heading"><span>智能集合</span></div>
          <div className="nav-row"><Sparkles size={15} /><span>等待 AI 分析</span><span className="row-count">43</span></div>
          <div className="nav-row"><CircleAlert size={15} /><span>背景需要清理</span><span className="row-count">18</span></div>
          <div className="nav-row"><FolderHeart size={15} /><span>已生成未选择</span><span className="row-count">27</span></div>
        </div>

        <div className="sidebar-section">
          <div className="section-heading"><span>标签</span><button type="button" aria-label="管理标签"><Tags size={13} /></button></div>
          <div className="tag-cloud">
            <span>人像</span><span>夜景</span><span>街拍</span><span>自然光</span>
          </div>
        </div>
      </div>
      <div className="storage-meter">
        <div><span>图库存储</span><span>184 GB / 500 GB</span></div>
        <div className="meter"><i /></div>
      </div>
    </aside>
  );
}

function Filmstrip({
  items,
  selected,
  selection,
  onSelect
}: {
  items: Photo[];
  selected: Photo;
  selection: SelectionState;
  onSelect: (photo: Photo, intent: SelectionIntent) => void;
}): React.JSX.Element {
  return (
    <section className="filmstrip-region">
      <div className="filmstrip-toolbar">
        <div className="result-summary"><strong>2026 人像作品</strong><span>128 张照片</span></div>
        <div className="filmstrip-tools">
          <button className="quiet-button" type="button"><ListFilter size={14} /> 筛选</button>
          <button className="quiet-button" type="button">拍摄时间 <ChevronDown size={12} /></button>
          <div className="segmented-control">
            <button className="is-active" type="button" aria-label="胶片视图"><GalleryHorizontalEnd size={14} /></button>
            <button type="button" aria-label="网格视图"><Grid2X2 size={14} /></button>
          </div>
        </div>
      </div>
      <div className="filmstrip" role="listbox" aria-label="照片">
        {items.map((photo, index) => (
          <button
            className={`thumb${selected.id === photo.id ? ' is-selected' : ''}`}
            key={photo.id}
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
        ))}
      </div>
    </section>
  );
}

function Viewer({ photo }: { photo: Photo }): React.JSX.Element {
  const [compareMode, setCompareMode] = useState<CompareMode>('single');
  const [split, setSplit] = useState(52);
  const [showOriginal, setShowOriginal] = useState(false);

  return (
    <section className="viewer">
      <div className="viewer-toolbar">
        <div className="viewer-title">
          <span>{photo.fileName}</span>
          <i>生成版本 2</i>
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
          {photo.src && !showOriginal && (
            <div
              className="generated-layer"
              style={compareMode === 'split' ? { clipPath: `inset(0 ${100 - split}% 0 0)` } : undefined}
            >
              <img src={photo.src} alt="AI 生成版本" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
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
        <div className="rating">{[1, 2, 3, 4, 5].map((value) => <Star key={value} size={13} fill={value <= photo.rating ? 'currentColor' : 'none'} />)}</div>
        <div className="version-switcher">
          <button type="button" onMouseDown={() => setShowOriginal(true)} onMouseUp={() => setShowOriginal(false)} onMouseLeave={() => setShowOriginal(false)}>
            按住查看原图 <kbd>O</kbd>
          </button>
          <span />
          <button type="button">原图</button>
          <button type="button">V1</button>
          <button className="is-current" type="button">V2</button>
          <button type="button"><Plus size={13} /></button>
        </div>
        <div className="file-meta"><span>{photo.format}</span><span>{photo.dimensions}</span></div>
      </div>
    </section>
  );
}

function AiPanel(): React.JSX.Element {
  const [actions, setActions] = useState({ people: true, light: true, texture: false });

  const toggle = (key: keyof typeof actions) => setActions((current) => ({ ...current, [key]: !current[key] }));

  return (
    <aside className="inspector">
      <div className="inspector-tabs"><button className="is-active" type="button"><Bot size={14} />AI</button><button type="button"><Info size={14} />信息</button><button type="button"><Layers3 size={14} />版本</button></div>
      <div className="inspector-scroll">
        <div className="analysis-head">
          <div className="analysis-score"><span>AI</span><strong>86</strong></div>
          <div><strong>自然光人像</strong><p>主体清晰，背景存在干扰元素</p></div>
          <span className="confidence">高置信度</span>
        </div>

        <div className="inspector-section">
          <div className="inspector-heading"><span>视觉分析</span><button type="button">查看完整报告</button></div>
          <p className="analysis-copy">柔和侧光塑造了自然肤色。建议保留浅景深和发丝细节，同时清理右后方路人并轻微提亮面部。</p>
          <div className="issue-row"><i className="severity high" /><span>背景路人分散注意力</span><em>严重</em></div>
          <div className="issue-row"><i className="severity medium" /><span>面部中间调略暗</span><em>中等</em></div>
        </div>

        <div className="inspector-section">
          <div className="inspector-heading"><span>AI 编辑动作</span><span className="section-count">2 项已启用</span></div>
          <ActionToggle title="清除背景路人" detail="自然补全街道与光影" checked={actions.people} onChange={() => toggle('people')} />
          <ActionToggle title="优化人物光线" detail="保持身份和肤色不变" checked={actions.light} onChange={() => toggle('light')} />
          <ActionToggle title="增强衣物纹理" detail="避免改变服装结构" checked={actions.texture} onChange={() => toggle('texture')} />
        </div>

        <div className="inspector-section">
          <div className="inspector-heading"><span>提示词模板</span><button type="button">浏览模板</button></div>
          <button className="template-choice" type="button">
            <span className="template-preview"><img src="./demo/portrait.jpg" alt="" /></span>
            <span><strong>自然人像 · 清洁背景</strong><small>保留身份、服装与真实光线</small></span>
            <ChevronRight size={15} />
          </button>
          <label className="instruction-field">
            <span>补充要求</span>
            <textarea defaultValue="保持自然皮肤纹理，不要过度磨皮。" rows={3} />
          </label>
        </div>
      </div>
      <div className="generate-footer">
        <div className="generation-count"><span>生成数量</span><div><button type="button">−</button><strong>3</strong><button type="button">+</button></div></div>
        <button className="primary-action" type="button"><Sparkles size={16} />加入生成队列</button>
      </div>
    </aside>
  );
}

function ActionToggle({ title, detail, checked, onChange }: { title: string; detail: string; checked: boolean; onChange: () => void }): React.JSX.Element {
  return (
    <button className="action-toggle" type="button" aria-pressed={checked} onClick={onChange}>
      <span className={`check-box${checked ? ' is-checked' : ''}`}>{checked && <Check size={12} />}</span>
      <span><strong>{title}</strong><small>{detail}</small></span>
      <span className="risk-chip">低风险</span>
    </button>
  );
}

function TaskBar({ open, onToggle }: { open: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <>
      {open && (
        <div className="task-drawer">
          <div className="drawer-head"><div><strong>当前任务</strong><span>生成任务将按顺序执行</span></div><div><button className="quiet-button" type="button"><Pause size={13} />暂停全部</button><IconButton label="关闭任务抽屉" onClick={onToggle}><X size={15} /></IconButton></div></div>
          <div className="task-row is-running"><span className="drag-handle">⠿</span><img src="./demo/portrait.jpg" alt="" /><span className="task-title"><strong>DSC_4821.NEF</strong><small>自然人像 · 清洁背景</small></span><span className="task-progress"><i style={{ width: '64%' }} /><em>正在生成 · 64%</em></span><span className="task-time">约 18 秒</span><IconButton label="暂停"><Pause size={14} /></IconButton></div>
          <div className="task-row"><span className="drag-handle">⠿</span><img src="./demo/coast.jpg" alt="" /><span className="task-title"><strong>A7R_0938.ARW</strong><small>自然风光 · 清除游客</small></span><span className="queued-label">队列第 1 位</span><span className="task-time">生成 2 次</span><IconButton label="开始"><Play size={14} /></IconButton></div>
        </div>
      )}
      <button className="task-statusbar" type="button" onClick={onToggle} aria-expanded={open}>
        <span className="working-pulse" /><strong>生成中 1</strong><span>等待 4</span><span className="failed-count">失败 1</span><span className="status-spacer" /><span>串行生成</span><PanelBottomOpen size={15} className={open ? 'is-open' : ''} />
      </button>
    </>
  );
}

function LibraryWorkspace({ availablePhotos }: { availablePhotos: Photo[] }): React.JSX.Element {
  const [selectedId, setSelectedId] = useState(availablePhotos[0]!.id);
  const [selection, setSelection] = useState<SelectionState>({
    selectedIds: new Set([availablePhotos[0]!.id]),
    anchorId: availablePhotos[0]!.id,
    focusId: availablePhotos[0]!.id
  });
  const [tasksOpen, setTasksOpen] = useState(false);
  const selected = availablePhotos.find((photo) => photo.id === selectedId) ?? availablePhotos[0]!;
  const orderedIds = useMemo(() => availablePhotos.map((photo) => photo.id), [availablePhotos]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
        event.preventDefault();
        setSelection(selectAll(orderedIds));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [orderedIds]);

  const selectPhoto = (photo: Photo, intent: SelectionIntent) => {
    setSelectedId(photo.id);
    setSelection((current) => updateSelection(current, orderedIds, photo.id, intent));
  };

  return (
    <div className="workspace">
      <Sidebar />
      <main className="library-main">
        <Filmstrip items={availablePhotos} selected={selected} selection={selection} onSelect={selectPhoto} />
        <Viewer photo={selected} />
      </main>
      <AiPanel />
      {selection.selectedIds.size > 1 && (
        <div className="batch-actionbar">
          <strong>已选择 {selection.selectedIds.size} 张</strong>
          <span />
          <button type="button"><Star size={14} />评分</button>
          <button type="button"><Tags size={14} />标签</button>
          <button type="button"><Sparkles size={14} />AI 分析</button>
          <button type="button"><WandSparkles size={14} />批量生成</button>
          <button type="button"><Download size={14} />导出</button>
          <IconButton label="清除选择" onClick={() => setSelection({ selectedIds: new Set(), anchorId: null, focusId: selected.id })}><X size={14} /></IconButton>
        </div>
      )}
      <TaskBar open={tasksOpen} onToggle={() => setTasksOpen((value) => !value)} />
    </div>
  );
}

function PlaceholderPage({ type }: { type: Exclude<WorkspaceTab, 'library'> }): React.JSX.Element {
  const data = useMemo(() => ({
    templates: { icon: WandSparkles, title: '提示词模板', copy: '管理描述、示例图片、模型能力和版本。', action: '新建模板' },
    tasks: { icon: Clock3, title: '任务中心', copy: '查看生成历史、失败原因、调用状态和批量操作。', action: '查看运行任务' },
    settings: { icon: SlidersHorizontal, title: '设置', copy: '配置分析模型、生成模型、受管存储、缓存和快捷键。', action: '添加模型配置' }
  })[type], [type]);
  const Icon = data.icon;

  return (
    <div className="placeholder-page">
      <div className="placeholder-rail">
        <strong>{data.title}</strong>
        {['概览', '模型与能力', '存储与缓存', '外观与快捷键'].map((item, index) => <button className={index === 0 ? 'is-active' : ''} key={item} type="button">{item}</button>)}
      </div>
      <div className="placeholder-content">
        <div className="page-heading"><div><span className="page-icon"><Icon size={22} /></span><div><h1>{data.title}</h1><p>{data.copy}</p></div></div><button className="primary-action compact" type="button"><Plus size={15} />{data.action}</button></div>
        <div className="empty-surface"><Icon size={32} /><h2>{data.title}工作区已就绪</h2><p>这个标签页将在对应里程碑接入真实数据和完整交互。</p></div>
      </div>
    </div>
  );
}

export function App(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('library');
  const [catalogPhotos, setCatalogPhotos] = useState<Photo[]>([]);

  useEffect(() => {
    void window.desktopApi.listCatalogAssets().then((assets) => setCatalogPhotos(mapCatalogAssets(assets)));
  }, []);

  const importFolders = async () => {
    const result = await window.desktopApi.importFolders();
    if (result) setCatalogPhotos(mapCatalogAssets(result.assets));
  };

  const availablePhotos = catalogPhotos.length > 0 ? catalogPhotos : photos;

  return (
    <div className="app-shell">
      <AppHeader active={activeTab} onChange={setActiveTab} onImport={() => void importFolders()} />
      {activeTab === 'library' ? <LibraryWorkspace availablePhotos={availablePhotos} /> : <PlaceholderPage type={activeTab} />}
    </div>
  );
}
