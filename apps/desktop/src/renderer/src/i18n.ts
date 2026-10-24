import { useSyncExternalStore } from 'react';

export type Locale = 'zh-CN' | 'en-US';

const messages = {
  'zh-CN': {
    library: '图库', viewer: '看图', agent: 'Agent 批处理', batch: 'AI 批量修图', workflow: 'AI 批量修图', templates: '提示词模板', tasks: '任务中心', settings: '设置',
    openWorkspace: '打开工作区', addFolder: '添加关联文件夹…', refreshCatalog: '刷新图库',
    analyze: '分析选中照片', generate: '生成修图结果', taskQueue: '任务队列', shortcuts: '快捷键',
    appearance: '外观', language: '界面语言', simplifiedChinese: '简体中文', english: 'English',
    followSystem: '跟随系统', dark: '深色', light: '浅色', aiModels: 'AI 模型', photo: '照片', view: '查看',
    file: '文件', edit: '编辑', help: '帮助', window: '窗口'
  },
  'en-US': {
    library: 'Library', viewer: 'Viewer', agent: 'Agent Batch', batch: 'AI Batch Edit', workflow: 'AI Batch Edit', templates: 'Prompt Templates', tasks: 'Task Center', settings: 'Settings',
    openWorkspace: 'Open workspace', addFolder: 'Add linked folder…', refreshCatalog: 'Refresh library',
    analyze: 'Analyze selected photos', generate: 'Generate edited results', taskQueue: 'Task queue', shortcuts: 'Shortcuts',
    appearance: 'Appearance', language: 'Language', simplifiedChinese: '简体中文', english: 'English',
    followSystem: 'System', dark: 'Dark', light: 'Light', aiModels: 'AI Models', photo: 'Photo', view: 'View',
    file: 'File', edit: 'Edit', help: 'Help', window: 'Window'
  }
} as const;

type MessageKey = keyof typeof messages['zh-CN'];
let currentLocale: Locale = 'zh-CN';
const listeners = new Set<() => void>();

export function getLocale(): Locale { return currentLocale; }
export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  document.documentElement.lang = locale;
  listeners.forEach((listener) => listener());
}
export function t(key: MessageKey, locale = currentLocale): string {
  return messages[locale][key] ?? messages['zh-CN'][key] ?? key;
}
export function useLocale(): Locale {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, getLocale, getLocale);
}
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
