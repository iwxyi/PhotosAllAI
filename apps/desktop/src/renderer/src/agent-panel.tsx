import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Bot, ChevronDown, Pause, Play, Send, Square, Trash2, X } from 'lucide-react';
import type { AgentAskInteraction, AgentSession, GenerationResult } from '@photoallisai/contracts';

const labels: Record<AgentSession['status'], string> = { idle: '就绪', running: '处理中', awaiting_input: '等待补充', awaiting_approval: '等待确认', waiting: '等待结果', paused: '已暂停', completed: '已完成', failed: '执行中断', canceled: '已取消' };
const toolLabels: Record<string, string> = { 'catalog.read': '读取图片', 'catalog.folders': '读取文件夹', 'providers.list': '选择模型', 'runtime.plan': '安排执行方案', 'vision.inspect': '视觉检查', 'analysis.read': '读取分析', 'generation.read': '读取生成版本', 'metadata.update': '修改图片信息', 'tags.update': '修改标签', 'jobs.submit': '处理图片', 'tasks.read': '检查作业', 'files.move': '移动文件', 'files.remove': '移出图库', 'runtime.wait': '等待' };
const active = (s: AgentSession | null) => !!s && ['running', 'waiting'].includes(s.status);
Object.assign(toolLabels, {
  'scope.request': '扩大图片范围', 'catalog.search': '查找图片', 'catalog.stats': '图库概况', 'tags.list': '读取标签',
  'collections.list': '读取智能集合', 'albums.list': '读取相册', 'albums.create': '创建相册', 'albums.save': '保存相册', 'albums.update': '整理相册', 'albums.delete': '删除相册',
  'folders.import': '关联文件夹', 'folders.synchronize': '同步文件夹', 'folders.create': '创建文件夹', 'folders.rename': '重命名文件夹', 'folders.move': '移动文件夹', 'folders.unregister': '取消关联文件夹',
  'files.copy': '复制图片', 'files.rename': '重命名图片', 'files.rename-many': '批量重命名', 'files.history': '读取操作记录', 'files.undo': '撤销文件操作',
  'files.rename-pattern.preview': '预览扩展名重命名', 'files.rename-pattern': '批量修改扩展名',
  'program.run': '运行文件处理程序',
  'generation.review': '审阅生成版本', 'generation.trash-list': '读取版本回收站', 'generation.trash': '回收生成版本', 'generation.restore': '恢复生成版本',
  'tasks.search': '查询作业', 'tasks.control': '管理关联作业', 'tasks.control-global': '管理其他作业', 'tasks.reorder': '调整作业顺序', 'tasks.update-generation': '调整排队提示词',
  'templates.list': '读取提示词模板', 'templates.save': '保存提示词模板', 'templates.archive': '归档提示词模板',
  'export.results': '导出生成版本', 'export.presets': '读取导出预设', 'export.preset-save': '保存导出预设', 'export.preset-delete': '删除导出预设',
  'workflow.read': '读取流程', 'workflow.configure': '修改流程', 'settings.read': '读取设置', 'settings.update': '修改设置', 'app.diagnostics': '检查程序状态'
});

type AgentPhoto = { id: string; fileName?: string; src?: string; thumbnailSrc?: string };

export function AgentPanel({ selectedIds, photos, onClose, onCollapse, onMove, onOpenResult, onOpenAsset }: {
  selectedIds: ReadonlySet<string>; photos: AgentPhoto[]; onClose(): void; onCollapse(): void; onMove(): void;
  onOpenResult(result: GenerationResult, results: GenerationResult[], assetIds: string[]): void;
  onOpenAsset(assetId: string, assetIds: string[]): void;
}): React.JSX.Element {
  const [session, setSession] = useState<AgentSession | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [results, setResults] = useState<GenerationResult[]>([]);
  const [assetNames, setAssetNames] = useState<Record<string, string>>({});
  const [folderNames, setFolderNames] = useState<Record<string, string>>({});
  const selected = photos.filter((p) => selectedIds.has(p.id)).map((p) => p.id);
  const currentId = useRef<string | null>(null);
  const mounted = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const userScroll = useRef(false);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const resize = new ResizeObserver(() => {
      if (followLatest.current) element.scrollTop = element.scrollHeight;
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  const polling = active(session);
  useEffect(() => {
    mounted.current = true;
    let live = true;
    void window.desktopApi.listAgentSessions().then((items) => {
      if (!live) return;
      setSessions(items);
      const remembered = localStorage.getItem('agent.session');
      const current = items.find((s) => s.id === remembered) ?? items[0] ?? null;
      currentId.current = current?.id ?? null; setSession(current);
    }).catch((e: unknown) => { if (live) setError(String(e)); }).finally(() => { if (live) setInitializing(false); });
    const timer = window.setInterval(() => {
      void window.desktopApi.listAgentSessions().then((items) => {
        if (!live) return;
        setSessions(items);
        setSession((current) => {
          if (!current || current.id !== currentId.current) return current;
          const updated = items.find((item) => item.id === current.id);
          return updated && updated.updatedAt > current.updatedAt ? updated : current;
        });
      }).catch(() => undefined);
    }, 2000);
    return () => { live = false; mounted.current = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    const id = session?.id;
    if (!id || !polling) return;
    let live = true;
    const timer = window.setInterval(() => {
      void window.desktopApi.getAgentSession(id).then((updated) => {
        if (live && currentId.current === id) setSession((current) => current?.id === id && current.updatedAt > updated.updatedAt ? current : updated);
      }).catch((e: unknown) => { if (live) setError(String(e)); });
    }, 600);
    return () => { live = false; clearInterval(timer); };
  }, [session?.id, polling]);
  const resultIdsKey = JSON.stringify(session?.calls.slice(session.requestCallStart ?? 0).flatMap((c) => c.resultIds) ?? []);
  const assetIdsKey = JSON.stringify(session?.assetIds ?? []);
  const approvalIdsKey = JSON.stringify(session?.calls.find((call) => call.status === 'approval')?.arguments.assetIds ?? []);
  useEffect(() => {
    let live = true; setResults([]);
    const wanted = new Set(JSON.parse(resultIdsKey) as string[]);
    if (wanted.size) void Promise.all((JSON.parse(assetIdsKey) as string[]).map((id) => window.desktopApi.listGenerationResults(id))).then((groups) => {
      if (live) setResults(groups.flat().filter((r) => wanted.has(r.id)));
    }).catch((e: unknown) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [resultIdsKey, assetIdsKey]);
  useEffect(() => {
    let live = true;
    const ids = [...new Set([...(JSON.parse(assetIdsKey) as string[]), ...(JSON.parse(approvalIdsKey) as string[])])];
    if (ids.length) void window.desktopApi.listCatalogAssetPage({ assetIds: ids, workflow: false, limit: 500 }).then((page) => {
      if (live) setAssetNames(Object.fromEntries(page.items.map((item) => [item.id, item.fileName])));
    }).catch(() => undefined);
    void window.desktopApi.listCatalogFolders().then((folders) => {
      if (live) setFolderNames(Object.fromEntries(folders.map((item) => [item.id, item.name])));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [assetIdsKey, approvalIdsKey]);
  useLayoutEffect(() => {
    if (followLatest.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'auto' });
  }, [session?.id, session?.messages.length, session?.status, results.length]);
  const select = async (id: string) => {
    setBusy(true);
    try {
      const s = await window.desktopApi.getAgentSession(id);
      if (mounted.current) {
        currentId.current = id; localStorage.setItem('agent.session', id);
        followLatest.current = true; setSession(s); setError('');
      }
    } finally { if (mounted.current) setBusy(false); }
  };
  const perform = async (fn: () => Promise<AgentSession>) => {
    setBusy(true); setError('');
    try {
      const s = await fn();
      if (mounted.current) { currentId.current = s.id; localStorage.setItem('agent.session', s.id); followLatest.current = true; setSession(s); setSessions((old) => [s, ...old.filter((x) => x.id !== s.id)]); }
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); const instruction = text.trim(); if (!instruction || busy || initializing || active(session)) return;
    void perform(async () => {
      const s = session ?? await window.desktopApi.createAgentSession({ assetIds: selected });
      currentId.current = s.id; localStorage.setItem('agent.session', s.id); setSession(s); setSessions((old) => [s, ...old.filter((x) => x.id !== s.id)]);
      const messageAssetIds = selected.length ? selected : s.assetIds;
      const next = await window.desktopApi.sendAgentMessage({ sessionId: s.id, text: instruction, ...(messageAssetIds.length ? { assetIds: messageAssetIds } : {}) }); setText(''); return next;
    });
  };
  const answerInteraction = (value: string) => {
    if (!session || busy || active(session) || session.status !== 'awaiting_input') return;
    void perform(() => window.desktopApi.sendAgentMessage({ sessionId: session.id, text: value, ...(selected.length ? { assetIds: selected } : {}) }));
  };
  const control = (action: 'pause' | 'resume' | 'cancel' | 'approve' | 'reject', callId?: string) => session && void perform(() => window.desktopApi.controlAgentSession({ sessionId: session.id, action, ...(callId ? { callId } : {}) }));
  const removeSession = async () => {
    if (!session || busy || active(session) || session.calls.some((call) => ['approval', 'executing', 'waiting', 'uncertain'].includes(call.status))) return;
    setBusy(true); setError('');
    try {
      await window.desktopApi.deleteAgentSession(session.id);
      const next = sessions.find((item) => item.id !== session.id && item.source !== 'external') ?? null;
      setSessions((items) => items.filter((item) => item.id !== session.id));
      currentId.current = next?.id ?? null;
      if (next) { localStorage.setItem('agent.session', next.id); setSession(next); }
      else { localStorage.removeItem('agent.session'); setSession(null); }
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const pending = session?.calls.find((c) => c.status === 'approval' || c.status === 'uncertain');
  const currentCall = session?.calls.find((c) => c.status === 'executing' || c.status === 'waiting');
  const interactionMessageId = session?.status === 'awaiting_input' ? [...session.messages].reverse().find((message) => message.role === 'assistant' && message.interaction)?.id : undefined;
  const canPause = active(session);
  const canResume = Boolean(session && ['paused', 'failed'].includes(session.status));
  const canCancel = Boolean(session && !['idle', 'completed', 'canceled'].includes(session.status));
  return <aside className="agent-dock-panel agent-conversation">
    <header className="agent-dock-header"><Bot size={15} /><div><strong>Agent</strong><span>{session ? labels[session.status] : '就绪'}</span></div><button type="button" aria-label="调整 Agent 面板顺序" onClick={onMove}><ArrowUp size={12} /></button><button type="button" aria-label="折叠 Agent 面板" onClick={onCollapse}><ChevronDown size={14} /></button><button type="button" aria-label="关闭 Agent" onClick={onClose}><X size={14} /></button></header>
    <div className="agent-session-bar"><select aria-label="Agent 会话" value={session?.id ?? '__new__'} disabled={busy || initializing} onChange={(e) => { if (e.target.value === '__new__') { void perform(() => window.desktopApi.createAgentSession({ assetIds: selected })); return; } void select(e.target.value).catch((err: unknown) => setError(String(err))); }}><option value="__new__">＋ 新对话</option>{sessions.length > 0 && <><option value="__conversation_separator__" disabled aria-hidden="true">────────────</option>{sessions.map((s) => <option key={s.id} value={s.id}>{s.source === 'external' ? 'MCP · ' : ''}{s.title}{s.status === 'awaiting_approval' ? ' · 待确认' : ''}</option>)}</>}</select><button type="button" title="删除当前对话" aria-label="删除当前对话" disabled={busy || initializing || !session || active(session) || session.calls.some((call) => ['approval', 'executing', 'waiting', 'uncertain'].includes(call.status))} onClick={() => void removeSession()}><Trash2 size={14} /></button></div>
    <div className="agent-dock-messages" ref={scroll} aria-live="polite"
      onWheel={() => { userScroll.current = true; }} onTouchMove={() => { userScroll.current = true; }}
      onPointerDown={() => { userScroll.current = true; }}
      onKeyDown={(e) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) userScroll.current = true; }} onScroll={() => {
      const el = scroll.current;
      if (el) {
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) followLatest.current = true;
        else if (userScroll.current) followLatest.current = false;
      }
      userScroll.current = false;
    }}>
      {session?.messages.map((m) => <div key={m.id} className={`agent-chat-message ${m.role}`}>
        {m.role === 'tool' ? session.calls.find((c) => c.id === m.callId)?.name === 'runtime.plan' ? <Plan detail={m.detail} /> : <details><summary>{toolLabels[session.calls.find((c) => c.id === m.callId)?.name ?? ''] ?? m.text}{session.calls.find((c) => c.id === m.callId)?.status === 'error' ? ' · 未完成' : ''}</summary><pre>{m.detail}</pre></details> : <><p>{m.text}</p>{m.role === 'user' && m.assetIds?.length ? <MessageAssets assetIds={m.assetIds} photos={photos} onOpenAsset={onOpenAsset} /> : null}{m.role === 'assistant' && m.id === interactionMessageId && m.interaction ? <AskInteraction interaction={m.interaction} disabled={busy} onAnswer={answerInteraction} /> : null}</>}
      </div>)}
      {currentCall && <div className="agent-live-status" role="status">{toolLabels[currentCall.name] ?? currentCall.name}{currentCall.taskIds.length ? ` · ${currentCall.taskIds.length} 项作业` : ''}…</div>}
      {!currentCall && session?.status === 'running' && <div className="agent-live-status" role="status">正在分析下一步…</div>}
    </div>
    {!!results.length && <div className="agent-result-strip">{results.map((r) => <button type="button" key={r.id} title={`${r.fileName} · V${r.version}`} aria-label={`查看 Agent 结果 V${r.version} ${r.fileName}`} onClick={() => onOpenResult(r, results, session?.assetIds ?? [])}><img src={r.resultUrl} alt={r.fileName} /><span>V{r.version}</span></button>)}</div>}
    {pending && <div className="agent-dock-confirm"><strong>{pending.status === 'uncertain' ? '请核对中断的操作' : toolLabels[pending.name] ?? pending.name}</strong><ApprovalDetails args={pending.arguments} assetNames={assetNames} folderNames={folderNames} />{pending.status === 'uncertain' && <span>操作可能已执行，请核对实际状态后继续。</span>}<div><button type="button" disabled={busy} onClick={() => control('approve', pending.id)}>{pending.status === 'uncertain' ? '已核对，继续' : '确认执行'}</button>{pending.status !== 'uncertain' && <button type="button" disabled={busy} onClick={() => control('reject', pending.id)}>不执行</button>}</div></div>}
    {(error || session?.error) && <p className="agent-error" role="alert">{error || session?.error}</p>}
    {session?.source !== 'external' && <form className="agent-dock-input" onSubmit={submit}><textarea aria-label="Agent 输入" value={text} onChange={(e) => setText(e.target.value)} placeholder="把这些照片修好" disabled={initializing || busy || active(session) || session?.status === 'canceled'} /><div className="agent-input-toolbar"><span className="agent-input-context">已选 {selected.length} 张</span><div className="agent-input-actions">{canPause && <button className="agent-input-control" type="button" title="暂停" aria-label="暂停 Agent" disabled={busy} onClick={() => control('pause')}><Pause size={14} /></button>}{canResume && <button className="agent-input-control" type="button" title="继续" aria-label="继续 Agent" disabled={busy} onClick={() => control('resume')}><Play size={14} /></button>}{canCancel && <button className="agent-input-control" type="button" title="取消" aria-label="取消 Agent" disabled={busy} onClick={() => control('cancel')}><Square size={13} /></button>}<button type="submit" aria-label="发送 Agent 指令" disabled={initializing || !text.trim() || busy || active(session) || session?.status === 'canceled'}><Send size={14} /></button></div></div></form>}
    {session?.source === 'external' && (canPause || canResume || canCancel) && <footer className="agent-dock-footer"><div>{canPause && <button type="button" title="暂停" aria-label="暂停 Agent" disabled={busy} onClick={() => control('pause')}><Pause size={14} /></button>}{canResume && <button type="button" title="继续" aria-label="继续 Agent" disabled={busy} onClick={() => control('resume')}><Play size={14} /></button>}{canCancel && <button type="button" title="取消" aria-label="取消 Agent" disabled={busy} onClick={() => control('cancel')}><Square size={13} /></button>}</div></footer>}
  </aside>;
}

function Plan({ detail }: { detail: string | undefined }): React.JSX.Element {
  try {
    const plan = JSON.parse(detail ?? '') as { goal?: string; steps?: string[]; acceptance?: string[] };
    return <div className="agent-plan"><strong>{plan.goal}</strong><ol>{plan.steps?.map((step, i) => <li key={i}>{step}</li>)}</ol><details><summary>验收标准</summary><ul>{plan.acceptance?.map((item, i) => <li key={i}>{item}</li>)}</ul></details></div>;
  } catch { return <pre>{detail}</pre>; }
}

function MessageAssets({ assetIds, photos, onOpenAsset }: { assetIds: string[]; photos: AgentPhoto[]; onOpenAsset(assetId: string, assetIds: string[]): void }): React.JSX.Element {
  return <details className="agent-message-assets"><summary>图片上下文 · {assetIds.length} 张</summary><div className="agent-message-assets-grid">{assetIds.map((id) => {
    const photo = photos.find((item) => item.id === id);
    return <button type="button" key={id} title={photo?.fileName ?? id} aria-label={`打开 ${photo?.fileName ?? '图片'}`} onClick={() => onOpenAsset(id, assetIds)}>{photo?.thumbnailSrc || photo?.src ? <img src={photo.thumbnailSrc ?? photo.src} alt={photo.fileName ?? ''} /> : <span>{photo?.fileName ?? '图片'}</span>}</button>;
  })}</div></details>;
}

function AskInteraction({ interaction, disabled, onAnswer }: { interaction: AgentAskInteraction; disabled: boolean; onAnswer(value: string): void }): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});
  const canSubmit = interaction.inputs.every((input) => !input.required || values[input.id]?.trim());
  const submit = () => {
    if (!canSubmit) return;
    onAnswer(JSON.stringify({ inputs: values }));
  };
  return <div className="agent-ask-interaction">
    {interaction.choices.length > 0 && <div className="agent-ask-choices">{interaction.choices.map((choice) => <button type="button" key={choice.id} disabled={disabled} title={choice.description} onClick={() => onAnswer(JSON.stringify({ choice: choice.id, label: choice.label }))}>{choice.label}</button>)}</div>}
    {interaction.inputs.length > 0 && <div className="agent-ask-inputs">{interaction.inputs.map((input) => <label key={input.id}><span>{input.label}{input.required ? ' *' : ''}</span><input value={values[input.id] ?? ''} placeholder={input.placeholder} disabled={disabled} onChange={(event) => setValues((current) => ({ ...current, [input.id]: event.target.value }))} /></label>)}<button type="button" disabled={disabled || !canSubmit} onClick={submit}>提交</button></div>}
  </div>;
}

function ApprovalDetails({ args, assetNames, folderNames }: { args: Record<string, unknown>; assetNames: Record<string, string>; folderNames: Record<string, string> }): React.JSX.Element {
  const label = (value: unknown, key: string): string => {
    if (Array.isArray(value)) return value.map((item) => label(item, key)).join('、');
    if (value && typeof value === 'object') return Object.entries(value).map(([field, item]) => `${approvalFieldLabels[field] ?? field}：${label(item, field)}`).join('，');
    if (typeof value !== 'string') return JSON.stringify(value);
    if (key.toLowerCase().includes('assetid')) return assetNames[value] ?? value;
    if (key.toLowerCase().includes('folderid')) return folderNames[value] ?? value;
    return value;
  };
  return <div className="agent-approval-fields">{Object.entries(args).map(([key, value]) => <div key={key}><span>{approvalFieldLabels[key] ?? key}</span><strong>{Array.isArray(value) ? value.map((item) => label(item, key)).join('、') : label(value, key)}</strong></div>)}<details><summary>完整参数</summary><pre>{JSON.stringify(args, null, 2)}</pre></details></div>;
}
const approvalFieldLabels: Record<string, string> = { assetIds: '图片', assetId: '图片', targetFolderId: '目标文件夹', sourceFolderId: '来源文件夹', folderId: '文件夹', resultIds: '版本', destinationDirectory: '导出目录', operationId: '操作记录', reason: '原因', name: '名称', fileName: '文件名', items: '修改内容', paths: '目录', action: '操作', scope: '操作范围', fromExtension: '原扩展名', toExtension: '目标扩展名' };
