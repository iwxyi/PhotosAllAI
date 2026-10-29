import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type StartupFailureDialog = {
  title: string;
  content: string;
};

export function writeStartupFailureLog(path: string, stage: string, error: unknown): boolean {
  try {
    const details = error instanceof Error ? error.stack ?? error.message : String(error);
    const redacted = details.replace(/Bearer\s+\S+|sk-[\w-]+/gi, '[redacted]')
      .replace(/https?:\/\/[^\s)]+/g, '[url]');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${new Date().toISOString()}\n阶段：${stage}\n${redacted.slice(0, 16000)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function createStartupFailureDialog(_error: unknown, stage?: string, logPath?: string): StartupFailureDialog {
  return {
    title: 'PhotoAllIsAI 无法启动',
    content: [
      '应用初始化失败，已停止启动。这是应用自身的错误提示。请保留现有图库数据，无需删除或恢复图库。',
      ...(stage ? [`失败阶段：${stage}`] : []),
      ...(logPath ? [`错误详情已保存至：\n${logPath}`] : ['请从终端启动应用以查看具体错误。'])
    ].join('\n\n')
  };
}
