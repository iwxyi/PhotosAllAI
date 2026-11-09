import { useState } from 'react';
import { X } from 'lucide-react';
import type { CatalogAlbum, CatalogFolder, CatalogSmartCollection, SmartCollectionRule } from '@photoallisai/contracts';

const fields: Array<{ value: SmartCollectionRule['conditions'][number]['field']; label: string; kind: 'number' | 'boolean' | 'string' }> = [
  { value: 'rating', label: '星级', kind: 'number' }, { value: 'favorite', label: '收藏', kind: 'boolean' },
  { value: 'flag', label: '留用旗标', kind: 'string' }, { value: 'labelColor', label: '颜色标签', kind: 'string' },
  { value: 'tag', label: '标签名称', kind: 'string' }, { value: 'fileName', label: '文件名', kind: 'string' },
  { value: 'folderName', label: '文件夹名称', kind: 'string' }, { value: 'albumName', label: '相册名称', kind: 'string' },
  { value: 'format', label: '格式', kind: 'string' }, { value: 'sizeBytes', label: '文件大小（字节）', kind: 'number' },
  { value: 'modifiedAt', label: '修改时间（毫秒）', kind: 'number' }, { value: 'importedAt', label: '导入时间（毫秒）', kind: 'number' },
  { value: 'importedWithinDays', label: '最近导入天数', kind: 'number' }, { value: 'offline', label: '离线', kind: 'boolean' },
  { value: 'analyzed', label: '已分析', kind: 'boolean' }, { value: 'generated', label: '已生成', kind: 'boolean' },
  { value: 'reviewState', label: '生成审阅状态', kind: 'string' },
  { value: 'width', label: '宽度（像素）', kind: 'number' }, { value: 'height', label: '高度（像素）', kind: 'number' },
  { value: 'cameraMake', label: '相机品牌', kind: 'string' }, { value: 'cameraModel', label: '相机型号', kind: 'string' },
  { value: 'lensMake', label: '镜头品牌', kind: 'string' }, { value: 'lensModel', label: '镜头型号', kind: 'string' },
  { value: 'city', label: '城市', kind: 'string' }, { value: 'country', label: '国家', kind: 'string' },
  { value: 'takenAt', label: '拍摄时间（毫秒）', kind: 'number' }, { value: 'exposureSeconds', label: '曝光秒数', kind: 'number' },
  { value: 'aperture', label: '光圈', kind: 'number' }, { value: 'focalLength', label: '焦距（毫米）', kind: 'number' },
  { value: 'iso', label: 'ISO', kind: 'number' }
];

const emptyRule: SmartCollectionRule = { version: 1, scope: { all: true, favorites: false, folders: false, albums: false, folderIds: [], albumIds: [] }, match: 'all', conditions: [] };
type Condition = SmartCollectionRule['conditions'][number];
const choices: Partial<Record<Condition['field'], Array<[string, string]>>> = {
  flag: [['picked', '留用'], ['rejected', '排除'], ['unflagged', '无旗标']],
  labelColor: [['red', '红色'], ['yellow', '黄色'], ['green', '绿色'], ['blue', '蓝色'], ['purple', '紫色']],
  reviewState: [['undecided', '未审阅'], ['accepted', '已接受'], ['preferred', '首选'], ['rejected', '已拒绝']]
};
function operatorsFor(field: typeof fields[number]): Condition['operator'][] {
  if (field.value === 'importedWithinDays') return ['lte'];
  if (field.value === 'reviewState' || field.kind === 'boolean') return ['eq', 'ne'];
  if (field.kind === 'number') return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'isSet', 'isNotSet'];
  if (field.value === 'folderName') return ['eq', 'ne', 'contains', 'notContains', 'regex'];
  if (field.value === 'tag' || field.value === 'albumName') return ['eq', 'ne', 'contains', 'notContains', 'startsWith', 'endsWith', 'regex'];
  return ['eq', 'ne', 'contains', 'notContains', 'startsWith', 'endsWith', 'regex', 'isSet', 'isNotSet'];
}
const operatorLabels: Record<Condition['operator'], string> = {
  eq: '等于', ne: '不等于', gt: '大于', gte: '不小于', lt: '小于', lte: '不大于',
  contains: '包含', notContains: '不包含', startsWith: '开头是', endsWith: '结尾是', regex: '正则匹配', isSet: '有值', isNotSet: '无值'
};

export function SmartCollectionEditor({ collection, folders, albums, onClose, onSave }: {
  collection: CatalogSmartCollection | null;
  folders: CatalogFolder[];
  albums: CatalogAlbum[];
  onClose: () => void;
  onSave: (name: string, rule: SmartCollectionRule) => Promise<void>;
}): React.JSX.Element {
  const [name, setName] = useState(collection?.name ?? '');
  const [rule, setRule] = useState<SmartCollectionRule>(() => structuredClone(collection?.rule ?? emptyRule));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const setScope = (patch: Partial<SmartCollectionRule['scope']>) => setRule((current) => ({ ...current, scope: { ...current.scope, ...patch } }));
  const toggleId = (key: 'folderIds' | 'albumIds', id: string) => setRule((current) => {
    const items = current.scope[key];
    return { ...current, scope: { ...current.scope, all: false, [key]: items.includes(id) ? items.filter((item) => item !== id) : [...items, id] } };
  });
  const toggleFolder = (folder: CatalogFolder) => setRule((current) => {
    const selected = current.scope.folderIds.includes(folder.id);
    const descendants = new Set<string>();
    if (!selected) {
      const pending = [folder.id];
      while (pending.length) {
        const parent = pending.pop()!;
        for (const child of folders) if (child.parentId === parent) { descendants.add(child.id); pending.push(child.id); }
      }
    }
    return { ...current, scope: { ...current.scope, all: false, folderIds: selected
      ? current.scope.folderIds.filter((id) => id !== folder.id)
      : [...current.scope.folderIds.filter((id) => !descendants.has(id)), folder.id] } };
  });
  const hasSelectedAncestor = (folder: CatalogFolder) => {
    let parentId = folder.parentId;
    while (parentId) {
      if (rule.scope.folderIds.includes(parentId)) return true;
      parentId = folders.find((item) => item.id === parentId)?.parentId ?? null;
    }
    return false;
  };
  const scopeSelected = rule.scope.all || rule.scope.favorites || rule.scope.folders || rule.scope.albums || rule.scope.folderIds.length > 0 || rule.scope.albumIds.length > 0;
  const updateCondition = (index: number, patch: Partial<Condition>) => setRule((current) => ({ ...current, conditions: current.conditions.map((item, at) => at === index ? { ...item, ...patch } : item) }));
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !scopeSelected) return;
    setBusy(true);
    setError('');
    try { await onSave(name.trim(), rule); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败'); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop sidebar-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="album-dialog smart-collection-dialog" role="dialog" aria-modal="true" aria-label={collection ? '编辑智能集合' : '创建智能集合'}>
      <form onSubmit={(event) => void save(event)}>
        <header><div><h2>{collection ? '编辑智能集合' : '创建智能集合'}</h2><p>选择照片来源，再设置动态筛选条件。</p></div><button type="button" className="quiet-button" onClick={onClose}>关闭</button></header>
        <div className="smart-collection-body">
        <label className="smart-collection-name">名称<input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
        <fieldset className="smart-collection-scope"><legend>范围 <small>多选后取并集</small></legend>
          <label><input type="checkbox" checked={rule.scope.all} onChange={(event) => setScope({ all: event.target.checked })} />所有照片</label>
          <label><input type="checkbox" checked={rule.scope.favorites} onChange={() => setScope({ all: false, favorites: !rule.scope.favorites })} />收藏</label>
          <label className="smart-collection-scope-parent"><input type="checkbox" checked={rule.scope.folders} onChange={(event) => setScope({ all: false, folders: event.target.checked, folderIds: event.target.checked ? [] : rule.scope.folderIds })} />关联文件夹 <small>全部关联目录</small></label>
          <div className="smart-collection-folder-list">{folders.map((folder) => <label key={folder.id} style={{ paddingLeft: folder.depth * 18 }}><input type="checkbox" disabled={rule.scope.all || rule.scope.folders || hasSelectedAncestor(folder)} checked={rule.scope.folderIds.includes(folder.id)} onChange={() => toggleFolder(folder)} />{folder.name}{folder.isRoot ? '（全部子目录）' : ''}</label>)}</div>
          {rule.scope.folderIds.filter((id) => !folders.some((folder) => folder.id === id)).map((missingId) => <label key={missingId} style={{ display: 'block' }}>原文件夹已变化，请重新关联：
            <select defaultValue="" onChange={(event) => setRule((current) => ({ ...current, scope: { ...current.scope, folderIds: current.scope.folderIds.map((id) => id === missingId ? event.target.value : id) } }))}>
              <option value="" disabled>选择当前位置</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{'　'.repeat(folder.depth)}{folder.name}</option>)}
            </select>
            <button type="button" onClick={() => setRule((current) => ({ ...current, scope: { ...current.scope, folderIds: current.scope.folderIds.filter((id) => id !== missingId) } }))}>移除旧范围</button>
          </label>)}
          <label className="smart-collection-scope-parent"><input type="checkbox" checked={rule.scope.albums} onChange={(event) => setScope({ all: false, albums: event.target.checked, albumIds: event.target.checked ? [] : rule.scope.albumIds })} />相册 <small>全部相册</small></label>
          {albums.map((album) => <label key={album.id} className="smart-collection-album"><input type="checkbox" disabled={rule.scope.all || rule.scope.albums} checked={rule.scope.albumIds.includes(album.id)} onChange={() => toggleId('albumIds', album.id)} />{album.name}</label>)}
        </fieldset>
        <fieldset className="smart-collection-conditions"><legend>条件</legend>
          <label>满足方式 <select value={rule.match} onChange={(event) => setRule((current) => ({ ...current, match: event.target.value as SmartCollectionRule['match'] }))}><option value="all">全部满足</option><option value="any">任一满足</option></select></label>
          {rule.conditions.map((condition, index) => {
            const field = fields.find((item) => item.value === condition.field)!;
            return <div className={`smart-collection-condition-row${condition.operator === 'isSet' || condition.operator === 'isNotSet' ? ' no-value' : ''}`} key={index}>
              <select aria-label={`条件 ${index + 1} 字段`} value={condition.field} onChange={(event) => {
                const next = fields.find((item) => item.value === event.target.value)!;
                updateCondition(index, { field: next.value, operator: next.value === 'importedWithinDays' ? 'lte' : 'eq', value: next.kind === 'boolean' ? true : next.kind === 'number' ? 0 : choices[next.value]?.[0]?.[0] ?? '' });
              }}>{fields.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
              <select aria-label={`条件 ${index + 1} 运算`} value={condition.operator} onChange={(event) => updateCondition(index, { operator: event.target.value as Condition['operator'] })}>
                {operatorsFor(field).map((operator) => <option key={operator} value={operator}>{operatorLabels[operator]}</option>)}
              </select>
              {condition.operator === 'isSet' || condition.operator === 'isNotSet' ? null : field.kind === 'boolean' ? <select aria-label={`条件 ${index + 1} 值`} value={String(condition.value)} onChange={(event) => updateCondition(index, { value: event.target.value === 'true' })}><option value="true">是</option><option value="false">否</option></select> : choices[field.value] ? <select aria-label={`条件 ${index + 1} 值`} value={String(condition.value)} onChange={(event) => updateCondition(index, { value: event.target.value })}>{choices[field.value]!.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : <input aria-label={`条件 ${index + 1} 值`} type={field.kind === 'number' ? 'number' : 'text'} value={condition.value === null ? '' : String(condition.value)} onChange={(event) => updateCondition(index, { value: field.kind === 'number' ? Number(event.target.value) : event.target.value })} />}
              <button className="smart-collection-remove-condition" type="button" aria-label={`删除条件 ${index + 1}`} title="删除条件" onClick={() => setRule((current) => ({ ...current, conditions: current.conditions.filter((_, at) => at !== index) }))}><X size={14} /></button>
            </div>;
          })}
          <button type="button" onClick={() => setRule((current) => ({ ...current, conditions: [...current.conditions, { field: 'rating', operator: 'gte', value: 0 }] }))}>添加条件</button>
        </fieldset>
        {error && <p role="alert" className="smart-collection-error">{error}</p>}
        </div>
        <footer><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="submit" className="primary-action compact" disabled={busy || !name.trim() || !scopeSelected}>{busy ? '保存中…' : '保存集合'}</button></footer>
      </form>
    </section>
  </div>;
}
