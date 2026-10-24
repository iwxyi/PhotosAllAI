import { Worker } from 'node:worker_threads';
import type { FileWorkflowPreset } from '@photoallisai/contracts';

export type WorkflowMatchFile = { id: string; relativePath: string; fileName: string; namespace: string; preset: FileWorkflowPreset };
export type WorkflowMatch = { id: string; group: string | null; key: string; stageId: string; stageName: string; stageIndex: number; variant: string; conflict: boolean };

// This function is self-contained because its source also runs in a disposable worker.
export function matchWorkflowFiles(files: WorkflowMatchFile[]): WorkflowMatch[] {
  const compiled = new Map<string, { step: FileWorkflowPreset['steps'][number]; regex: RegExp; index: number }[]>();
  return files.map((file) => {
    const cacheKey = JSON.stringify(file.preset);
    let steps = compiled.get(cacheKey);
    if (!steps) {
      steps = file.preset.steps.map((step, index) => ({ step, index, regex: new RegExp(step.pattern, step.ignoreCase ? 'iu' : 'u') }));
      compiled.set(cacheKey, steps);
    }
    const hits = steps.flatMap(({ step, regex, index }) => {
      const result = regex.exec(file[step.field]);
      if (!result?.groups?.key?.trim()) return [];
      const key = result.groups.key.trim().normalize('NFC');
      const project = (result.groups.project ?? '').normalize('NFC');
      return [{ id: file.id, group: JSON.stringify([file.namespace, project, key]), key, stageId: step.id, stageName: step.name, stageIndex: index, variant: result.groups.variant ?? '', conflict: false }];
    });
    return hits.length === 1 ? hits[0]! : { id: file.id, group: null, key: '', stageId: '', stageName: '', stageIndex: -1, variant: '', conflict: hits.length > 1 };
  });
}

export async function matchWorkflowFilesIsolated(files: WorkflowMatchFile[], timeoutMs = 2000): Promise<WorkflowMatch[]> {
  if (files.length === 0) return [];
  const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
    parentPort.postMessage((${matchWorkflowFiles.toString()})(workerData));`, { eval: true, workerData: files });
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error, result?: WorkflowMatch[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error('正则匹配超时，请简化流程规则后重试。')), timeoutMs);
    worker.once('message', (result: WorkflowMatch[]) => finish(undefined, result));
    worker.once('error', () => finish(new Error('流程规则执行失败，请检查正则表达式。')));
    worker.once('exit', (code) => { if (!finished) finish(new Error(`流程匹配意外退出（${code}）。`)); });
  });
}
