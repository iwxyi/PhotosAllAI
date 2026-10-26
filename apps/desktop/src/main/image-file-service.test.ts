import { mkdtemp, copyFile, rm, mkdir, symlink, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageFileService } from './image-file-service';

const directories: string[] = [];
const fixture = path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg');
async function setup() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'photoallisai-image-open-')));
  directories.push(directory);
  const resolveAssetFile = vi.fn(() => null);
  return { directory, resolveAssetFile, service: new ImageFileService({ resolveAssetFile }) };
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('temporary image browsing', () => {
  it('opens siblings in natural order without requiring catalog records', async () => {
    const { directory, service, resolveAssetFile } = await setup();
    for (const name of ['photo10.jpg', 'photo2.jpg', 'photo1.jpg']) await copyFile(fixture, path.join(directory, name));
    await writeFile(path.join(directory, 'notes.txt'), 'ignore');
    await mkdir(path.join(directory, 'nested.jpg'));
    const session = await service.open([path.join(directory, 'photo2.jpg')]);
    expect(session.items.map((item) => item.fileName)).toEqual(['photo1.jpg', 'photo2.jpg', 'photo10.jpg']);
    expect(session.items.find((item) => item.id === session.selectedId)?.fileName).toBe('photo2.jpg');
    expect(service.resolve(session.selectedId)).toBe(path.join(directory, 'photo2.jpg'));
    expect(resolveAssetFile).not.toHaveBeenCalled();
    expect(session.items.every((item) => item.folderId === '' && item.thumbnailUrl.startsWith('photoasset://temporary-thumbnail/'))).toBe(true);
  });

  it('deduplicates aliases and limits multiple-file opens to the supplied files', async () => {
    const { directory, service } = await setup();
    const source = path.join(directory, 'source.jpg');
    const alias = path.join(directory, 'alias.jpg');
    await copyFile(fixture, source);
    await symlink(source, alias);
    await copyFile(fixture, path.join(directory, 'other.jpg'));
    const session = await service.open([alias, source]);
    expect(session.items).toHaveLength(1);
    expect(service.resolve(session.selectedId)).toBe(source);
  });

  it('keeps the prior session on failure and revokes it after a successful replacement', async () => {
    const { directory, service } = await setup();
    const source = path.join(directory, 'source.jpg');
    await copyFile(fixture, source);
    const first = await service.open([source]);
    await expect(service.open([path.join(directory, 'missing.jpg')])).rejects.toThrow();
    expect(service.resolve(first.selectedId)).toBe(source);
    const second = await service.open([source]);
    expect(service.resolve(first.selectedId)).toBeNull();
    expect(service.resolve(second.selectedId)).toBe(source);
  });

  it('returns actual file details and reports unavailable files', async () => {
    const { directory, service } = await setup();
    const source = path.join(directory, 'source.jpg');
    await copyFile(fixture, source);
    const session = await service.open([source]);
    const details = await service.details(session.selectedId);
    expect(details.path).toBe(source);
    expect(details.sizeBytes).toBeGreaterThan(100);
    expect(details.modifiedAt).toBeGreaterThan(0);
    await rm(source);
    await expect(service.details(session.selectedId)).rejects.toThrow();
    await expect(service.details('unknown')).rejects.toThrow('图片已从图库移除');
  });

  it('rejects empty directories, unsupported files, and empty requests', async () => {
    const { directory, service } = await setup();
    await expect(service.open([])).rejects.toThrow('请选择图片文件');
    await expect(service.open([directory])).rejects.toThrow('没有可查看的图片');
    const text = path.join(directory, 'notes.txt');
    await writeFile(text, 'not an image');
    await expect(service.open([text])).rejects.toThrow('不支持的图片格式');
  });
});
