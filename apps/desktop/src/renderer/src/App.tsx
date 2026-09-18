import { useEffect, useMemo, useState } from 'react';
import type {
  CatalogAsset,
  AnalysisRevision,
  PersistedTask,
  PromptTemplate,
  ProviderProfile,
  SavePromptTemplateInput,
  SaveProviderProfileInput
} from '@photoallisai/contracts';
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
  Command,
  Download,
  Folder,
  FolderHeart,
  FolderOpen,
  GalleryHorizontalEnd,
  Grid2X2,
  Image,
  Info,
  KeyRound,
  Layers3,
  ListFilter,
  Maximize2,
  PanelBottomOpen,
  Pause,
  Play,
  Plus,
  Search,
  Server,
  Settings,
  Sparkles,
  Star,
  ShieldCheck,
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

function AiPanel({
  revision,
  isDemo,
  notice,
  onAnalyze
}: {
  revision: AnalysisRevision | undefined;
  isDemo: boolean;
  notice: string;
  onAnalyze: () => void;
}): React.JSX.Element {
  const [actions, setActions] = useState({ people: true, light: true, texture: false });
  const [disabledActions, setDisabledActions] = useState<Set<string>>(new Set());

  const toggle = (key: keyof typeof actions) => setActions((current) => ({ ...current, [key]: !current[key] }));
  const result = revision?.result;
  const score = isDemo ? 86 : result ? Math.round(result.quality.overallScore) : '--';
  const summary = isDemo ? '自然光人像' : result?.summary ?? '等待视觉分析';
  const description = isDemo ? '主体清晰，背景存在干扰元素' : result ? result.catalog.shortDescription : '尚未生成分析与编目数据';
  const enabledActionCount = isDemo
    ? Object.values(actions).filter(Boolean).length
    : result?.generativeActions.filter((action) => action.enabled && !disabledActions.has(action.id)).length ?? 0;

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
        <button className="primary-action" type="button" disabled={!isDemo && !result}><Sparkles size={16} />加入生成队列</button>
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

function LibraryWorkspace({ availablePhotos, isDemo }: { availablePhotos: Photo[]; isDemo: boolean }): React.JSX.Element {
  const [selectedId, setSelectedId] = useState(availablePhotos[0]!.id);
  const [selection, setSelection] = useState<SelectionState>({
    selectedIds: new Set([availablePhotos[0]!.id]),
    anchorId: availablePhotos[0]!.id,
    focusId: availablePhotos[0]!.id
  });
  const [tasksOpen, setTasksOpen] = useState(false);
  const [visionProfiles, setVisionProfiles] = useState<ProviderProfile[]>([]);
  const [analysisRevision, setAnalysisRevision] = useState<AnalysisRevision>();
  const [analysisNotice, setAnalysisNotice] = useState('');
  const [taskItems, setTaskItems] = useState<PersistedTask[]>([]);
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

  useEffect(() => {
    if (isDemo) return;
    void window.desktopApi.listProviderProfiles().then((items) =>
      setVisionProfiles(items.filter((profile) => profile.purpose === 'vision' && profile.enabled))
    );
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
    const refresh = () => { void window.desktopApi.listTasks().then((items) => { if (active) setTaskItems(items); }); };
    refresh();
    const interval = window.setInterval(refresh, 1_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [isDemo]);

  const selectPhoto = (photo: Photo, intent: SelectionIntent) => {
    setSelectedId(photo.id);
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

  return (
    <div className="workspace">
      <Sidebar />
      <main className="library-main">
        <Filmstrip items={availablePhotos} selected={selected} selection={selection} onSelect={selectPhoto} />
        <Viewer photo={selected} />
      </main>
      <AiPanel revision={analysisRevision} isDemo={isDemo} notice={analysisNotice} onAnalyze={() => void analyzeSelection()} />
      {selection.selectedIds.size > 1 && (
        <div className="batch-actionbar">
          <strong>已选择 {selection.selectedIds.size} 张</strong>
          <span />
          <button type="button"><Star size={14} />评分</button>
          <button type="button"><Tags size={14} />标签</button>
          <button type="button" onClick={() => void analyzeSelection()}><Sparkles size={14} />AI 分析</button>
          <button type="button"><WandSparkles size={14} />批量生成</button>
          <button type="button"><Download size={14} />导出</button>
          <IconButton label="清除选择" onClick={() => setSelection({ selectedIds: new Set(), anchorId: null, focusId: selected.id })}><X size={14} /></IconButton>
        </div>
      )}
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

function TaskCenterPage(): React.JSX.Element {
  const [taskItems, setTaskItems] = useState<PersistedTask[]>([]);

  const refresh = () => window.desktopApi.listTasks().then(setTaskItems);
  useEffect(() => { void window.desktopApi.listTasks().then(setTaskItems); }, []);

  const cancel = async (taskId: string) => {
    await window.desktopApi.cancelTask(taskId);
    await refresh();
  };
  const retry = async (taskId: string) => {
    await window.desktopApi.retryTask(taskId);
    await refresh();
  };

  const waiting = taskItems.filter((task) => task.status === 'queued').length;
  const failed = taskItems.filter((task) => task.status === 'failed').length;

  return (
    <div className="task-center-page">
      <div className="task-center-heading">
        <div><h1>任务中心</h1><p>生成任务默认串行执行，等待任务可以调整或取消。</p></div>
        <div className="task-summary"><span><i className="task-dot queued" />等待 {waiting}</span><span><i className="task-dot failed" />失败 {failed}</span></div>
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
              {(task.status === 'queued' || task.status === 'preparing' || task.status === 'uploading' || task.status === 'processing' || task.status === 'downloading') && <button type="button" onClick={() => void cancel(task.id)}>取消</button>}
              {(task.status === 'failed' || task.status === 'canceled') && <button type="button" onClick={() => void retry(task.id)}>重试</button>}
            </span>
          </div>
        ))}
      </div>
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
      {activeTab === 'library' ? <LibraryWorkspace availablePhotos={availablePhotos} isDemo={catalogPhotos.length === 0} /> : activeTab === 'settings' ? <SettingsPage /> : activeTab === 'tasks' ? <TaskCenterPage /> : <TemplatePage />}
    </div>
  );
}
