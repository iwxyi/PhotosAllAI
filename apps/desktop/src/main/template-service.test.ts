import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TemplateService } from './template-service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function service(): Promise<TemplateService> {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-templates-'));
  temporaryDirectories.push(directory);
  return new TemplateService(path.join(directory, 'catalog.sqlite'));
}

describe('prompt template versions', () => {
  it('creates immutable versions and lists only the latest snapshot', async () => {
    const templates = await service();
    const first = templates.save({ name: '清洁背景', description: '移除干扰物', category: '局部修饰', body: '移除 {{analysis.generative_actions}}', exampleImage: 'data:image/png;base64,AA==' });
    const second = templates.save({ id: first.id, name: '清洁背景', description: '移除干扰物', category: '局部修饰', body: '执行：\n{{analysis.generative_actions}}', exampleImage: 'data:image/png;base64,AA==' });
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(templates.list()).toEqual([second]);
    expect(templates.listSummaries()).toMatchObject([{ id: first.id, category: '局部修饰', description: '移除干扰物' }]);
    expect(templates.get(first.id)).toEqual(second);
    const preserved = templates.save({ id: first.id, name: '清洁背景', description: '更新描述', category: '局部修饰', body: '保留已有示例图' });
    expect(preserved.exampleImage).toBe(first.exampleImage);
    expect(templates.get(first.id).exampleImage).toBe(first.exampleImage);
    expect(templates.save({ id: first.id, name: '清洁背景', description: '移除示例', category: '局部修饰', body: '清除', exampleImage: '' }).exampleImage).toBe('');
    templates.archive(first.id);
    expect(templates.list()).toEqual([]);
    expect(() => templates.save({ id: first.id, name: '恢复', description: '恢复模板', category: '局部修饰', body: 'Body' })).toThrow('TEMPLATE_ARCHIVED');
    templates.close();
  });

  it('does not update an unknown template id', async () => {
    const templates = await service();
    expect(() => templates.save({ id: 'c01c942f-75e5-4fdd-884b-9f31d328ea6f', name: 'Unknown', description: '未知模板', category: '临时', body: 'Body' })).toThrow('TEMPLATE_NOT_FOUND');
    templates.close();
  });
});
