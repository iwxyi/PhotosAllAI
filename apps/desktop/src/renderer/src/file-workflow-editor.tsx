import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Copy, GitBranch, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { DEFAULT_FILE_WORKFLOW, fileWorkflowConfigSchema, type CatalogAssetPage, type CatalogFolder, type FileWorkflowConfig, type FileWorkflowPreset, type FileWorkflowScope } from '@photoallisai/contracts';

const emptyConfig = (): FileWorkflowConfig => fileWorkflowConfigSchema.parse({});
const clone = <T,>(value: T): T => structuredClone(value);
type Props = { scope: FileWorkflowScope; folders: CatalogFolder[]; scopeName: string; onClose?: () => void };

function inheritedSource(config: FileWorkflowConfig, folders: CatalogFolder[], scope: FileWorkflowScope): string {
  let current = folders.find((folder) => folder.id === scope.folderId)?.parentId;
  while (current) {
    const folder = folders.find((item) => item.id === current);
    if (config.folders[current]) return folder?.name ?? '父文件夹';
    current = folder?.parentId;
  }
  return '全局默认';
}

export function FileWorkflowEditor({ scope, folders, scopeName, onClose }: Props): React.JSX.Element {
  const [config, setConfig] = useState<FileWorkflowConfig>(emptyConfig);
  const [ready, setReady] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<CatalogAssetPage | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const global = !scope.folderId && !scope.albumId;
  const bindings = scope.albumId ? config.albums : config.folders;
  const scopeId = scope.albumId ?? scope.folderId;
  const binding = scopeId ? bindings[scopeId] : undefined;
  const mode = global ? config.defaultPresetId ?? 'off' : binding?.mode === 'custom' ? 'custom' : binding?.mode === 'preset' ? binding.presetId : binding?.mode ?? 'inherit';
  const preset = binding?.mode === 'custom' ? binding.preset : config.presets.find((item) => item.id === editingId);
  const change = (next: FileWorkflowConfig) => { setConfig(next); setPreview(null); setMessage(''); };

  useEffect(() => {
    let active = true;
    void window.desktopApi.getFileWorkflowConfig().then((value) => {
      if (!active) return;
      setConfig(value);
      const current = scope.albumId ? value.albums[scope.albumId] : scope.folderId ? value.folders[scope.folderId] : undefined;
      setEditingId(current?.mode === 'preset' ? current.presetId : value.defaultPresetId ?? value.presets[0]?.id ?? null);
      setReady(true);
    }).catch(() => { if (active) setMessage('无法读取流程配置，请重新打开。'); });
    return () => { active = false; };
  }, [scope.albumId, scope.folderId]);

  const setMode = (value: string) => {
    const next = clone(config);
    if (global) next.defaultPresetId = value === 'off' ? null : value;
    else {
      const target = scope.albumId ? next.albums : next.folders;
      if (value === 'inherit') delete target[scopeId!];
      else if (value === 'off') target[scopeId!] = { mode: 'off' };
      else if (value === 'custom') {
        let source: FileWorkflowPreset | undefined;
        if (binding?.mode === 'preset') source = config.presets.find((item) => item.id === binding.presetId);
        if (!binding) {
          let current = scope.folderId ? folders.find((item) => item.id === scope.folderId)?.parentId : null;
          while (current) {
            const parent = config.folders[current];
            if (parent) { source = parent.mode === 'custom' ? parent.preset : parent.mode === 'preset' ? config.presets.find((item) => item.id === parent.presetId) : undefined; break; }
            current = folders.find((item) => item.id === current)?.parentId;
          }
        }
        source ??= config.presets.find((item) => item.id === config.defaultPresetId) ?? DEFAULT_FILE_WORKFLOW;
        target[scopeId!] = { mode: 'custom', preset: { ...clone(source), id: crypto.randomUUID(), name: `${scopeName}流程` } };
      } else target[scopeId!] = { mode: 'preset', presetId: value };
    }
    if (!['off', 'inherit', 'custom'].includes(value)) setEditingId(value);
    change(next);
  };

  const updatePreset = (nextPreset: FileWorkflowPreset) => {
    const next = clone(config);
    if (binding?.mode === 'custom') (scope.albumId ? next.albums : next.folders)[scopeId!] = { mode: 'custom', preset: nextPreset };
    else next.presets = next.presets.map((item) => item.id === nextPreset.id ? nextPreset : item);
    change(next);
  };
  const addPreset = (source = DEFAULT_FILE_WORKFLOW) => {
    const nextPreset = { ...clone(source), id: crypto.randomUUID(), name: source === DEFAULT_FILE_WORKFLOW ? '摄影后期' : `${source.name}副本` };
    const next = { ...clone(config), presets: [...config.presets, nextPreset] };
    if (global && !next.defaultPresetId) next.defaultPresetId = nextPreset.id;
    if (!global && scopeId) (scope.albumId ? next.albums : next.folders)[scopeId] = { mode: 'preset', presetId: nextPreset.id };
    change(next);
    setEditingId(nextPreset.id);
  };
  const run = async (save: boolean) => {
    const parsed = fileWorkflowConfigSchema.safeParse(config);
    if (!parsed.success) { setMessage(parsed.error.issues.map((issue) => issue.message).join('；')); return; }
    setBusy(true); setMessage('');
    try {
      const result = await window.desktopApi.previewFileWorkflow({ ...scope, config: parsed.data });
      setPreview(result);
      if (save) {
        const saved = await window.desktopApi.saveFileWorkflowConfig(parsed.data);
        setConfig(saved); setMessage('已保存');
      }
    } catch (error) { setMessage(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '无法处理流程配置'); }
    finally { setBusy(false); }
  };

  return <section className="file-workflow-editor" aria-busy={busy}>
    <header><strong>{scopeName}</strong>{onClose && <button type="button" aria-label="关闭流程配置" title="关闭" disabled={busy} onClick={onClose}><X size={16} /></button>}</header>
    {ready && <>
      <label className="workflow-field"><span>{global ? '默认流程' : '流程配置'}</span><select aria-label="流程配置方式" value={mode} disabled={busy} onChange={(event) => setMode(event.target.value)}>
        {!global && <option value="inherit">继承（{inheritedSource(config, folders, scope)}）</option>}
        <option value="off">关闭聚合</option>
        {config.presets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        {!global && <option value="custom">自定义</option>}
      </select></label>
      <div className="workflow-preset-actions">
        {binding?.mode !== 'custom' && <select aria-label="编辑流程预设" value={editingId ?? ''} onChange={(event) => setEditingId(event.target.value)} disabled={busy}><option value="" disabled>选择预设</option>{config.presets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
        <button type="button" title="新建流程预设" disabled={busy} onClick={() => addPreset()}><Plus size={14} />新建预设</button>
        {preset && <button type="button" title="复制为预设" disabled={busy} onClick={() => addPreset(preset)}><Copy size={14} /></button>}
        {preset && binding?.mode !== 'custom' && <button type="button" title="删除预设" aria-label="删除流程预设" disabled={busy} onClick={() => {
          const used = [...Object.values(config.folders), ...Object.values(config.albums)].some((item) => item.mode === 'preset' && item.presetId === preset.id);
          if (used) { setMessage('此预设仍被文件夹或相册使用，请先更改它们的配置。'); return; }
          change({ ...config, defaultPresetId: config.defaultPresetId === preset.id ? null : config.defaultPresetId, presets: config.presets.filter((item) => item.id !== preset.id) });
          setEditingId(config.presets.find((item) => item.id !== preset.id)?.id ?? null);
        }}><Trash2 size={14} /></button>}
      </div>
      {preset && <fieldset disabled={busy} className="workflow-preset-editor">
        <label className="workflow-field"><span>{binding?.mode === 'custom' ? '流程名称' : '共享预设名称'}</span><input aria-label="流程名称" value={preset.name} maxLength={80} onChange={(event) => updatePreset({ ...preset, name: event.target.value })} /></label>
        {preset.steps.map((step, index) => <details className="workflow-step" key={step.id}><summary><span>{index + 1}. {step.name || '未命名步骤'}</span></summary><div className="workflow-step-fields">
          <label className="workflow-field"><span>步骤名称</span><input aria-label={`步骤 ${index + 1} 名称`} value={step.name} onChange={(event) => updatePreset({ ...preset, steps: preset.steps.map((item) => item.id === step.id ? { ...item, name: event.target.value } : item) })} /></label>
          <label className="workflow-field"><span>匹配字段</span><select aria-label={`步骤 ${index + 1} 匹配字段`} value={step.field} onChange={(event) => updatePreset({ ...preset, steps: preset.steps.map((item) => item.id === step.id ? { ...item, field: event.target.value as 'fileName' | 'relativePath' } : item) })}><option value="relativePath">相对路径</option><option value="fileName">文件名</option></select></label>
          <label className="workflow-field"><span>正则 · 图片键 key / 项目 project / 候选 variant</span><textarea spellCheck={false} aria-label={`步骤 ${index + 1} 正则`} rows={2} value={step.pattern} onChange={(event) => updatePreset({ ...preset, steps: preset.steps.map((item) => item.id === step.id ? { ...item, pattern: event.target.value } : item) })} /></label>
          <div className="workflow-step-actions"><label><input type="checkbox" checked={step.ignoreCase} onChange={(event) => updatePreset({ ...preset, steps: preset.steps.map((item) => item.id === step.id ? { ...item, ignoreCase: event.target.checked } : item) })} />忽略大小写</label>
            <button type="button" title="上移" aria-label={`上移步骤 ${index + 1}`} disabled={index === 0} onClick={() => { const steps = [...preset.steps]; [steps[index - 1], steps[index]] = [steps[index]!, steps[index - 1]!]; updatePreset({ ...preset, steps }); }}><ArrowUp size={13} /></button>
            <button type="button" title="下移" aria-label={`下移步骤 ${index + 1}`} disabled={index === preset.steps.length - 1} onClick={() => { const steps = [...preset.steps]; [steps[index], steps[index + 1]] = [steps[index + 1]!, steps[index]!]; updatePreset({ ...preset, steps }); }}><ArrowDown size={13} /></button>
            <button type="button" title="删除步骤" aria-label={`删除步骤 ${index + 1}`} disabled={preset.steps.length === 1} onClick={() => updatePreset({ ...preset, steps: preset.steps.filter((item) => item.id !== step.id) })}><Trash2 size={13} /></button>
          </div>
        </div></details>)}
        <button type="button" disabled={preset.steps.length >= 30} onClick={() => updatePreset({ ...preset, steps: [...preset.steps, { id: crypto.randomUUID(), name: '新步骤', field: 'relativePath', pattern: '^(?<key>.+)\\.[^.]+$', ignoreCase: true }] })}><Plus size={14} />添加步骤</button>
      </fieldset>}
      {preview && <div className="workflow-match-preview" aria-label="流程匹配预览"><strong>{preview.totalCount} 组 · 匹配 {preview.workflowStatus?.matched ?? 0} · 未匹配 {preview.workflowStatus?.unmatched ?? preview.totalCount} · 冲突 {preview.workflowStatus?.conflicts ?? 0}</strong>
        {preview.items.map((asset) => <details key={asset.id}><summary><img src={asset.thumbnailUrl} alt="" /><span>{asset.workflow?.key ?? asset.fileName}</span><small>{asset.workflowConflict ? '规则冲突' : asset.workflow ? `${asset.workflow.members.length} 个版本` : '未匹配'}</small></summary>{asset.workflow?.members.map((member) => <div className="workflow-preview-member" key={member.asset.id}><span>{member.stageName}{member.variant && ` · ${member.variant}`}</span><span>{member.asset.fileName}</span></div>)}</details>)}
        {preview.nextCursor && <small>预览显示前 100 组，统计包含全部图片。</small>}
      </div>}
      <footer><span role="status">{message}</span><button type="button" disabled={busy} onClick={() => void run(false)}><RefreshCw size={14} />预览</button><button className="primary-action compact" type="button" disabled={busy} onClick={() => void run(true)}><Save size={14} />{busy ? '处理中' : '保存'}</button></footer>
    </>}
    {!ready && <p role="status">{message || '读取中…'}</p>}
  </section>;
}

export function FileWorkflowControl(props: Omit<Props, 'onClose'>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || dialogRef.current?.querySelector('[aria-busy="true"]')) return;
      event.preventDefault(); event.stopImmediatePropagation(); setOpen(false);
    };
    window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('keydown', escape, true); previous?.focus({ preventScroll: true }); };
  }, [open]);
  return <><button className="quiet-button" type="button" title="流程配置" aria-label="流程配置" onClick={() => setOpen(true)}><GitBranch size={14} /></button>{open && createPortal(<div className="modal-backdrop file-workflow-backdrop"><div className="file-workflow-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label="流程配置" tabIndex={-1} onKeyDown={(event) => {
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary')].filter((element) => element.getClientRects().length > 0);
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first?.focus(); }
  }}><FileWorkflowEditor {...props} onClose={() => setOpen(false)} /></div></div>, document.body)}</>;
}
