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
    const first = templates.save({ name: '清洁背景', description: '移除干扰物', category: '人像', body: '移除 {{analysis.generative_actions}}' });
    const second = templates.save({ id: first.id, name: '清洁背景', description: '移除干扰物', category: '人像', body: '执行：\n{{analysis.generative_actions}}' });
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(templates.list()).toEqual([second]);
    templates.close();
  });

  it('does not update an unknown template id', async () => {
    const templates = await service();
    expect(() => templates.save({ id: 'c01c942f-75e5-4fdd-884b-9f31d328ea6f', name: 'Unknown', description: '', category: '其他', body: 'Body' })).toThrow('TEMPLATE_NOT_FOUND');
    templates.close();
  });
});

