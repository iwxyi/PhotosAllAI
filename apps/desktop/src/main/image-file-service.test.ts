import { mkdtemp, copyFile, rm, mkdir, symlink, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageFileService } from './image-file-service';
import { TemporaryMediaIndex } from './temporary-media-index';

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

  it('opens a large directory without requiring metadata reads for every sibling', async () => {
    const { directory, service } = await setup();
    const names = Array.from({ length: 2_000 }, (_, index) => `frame${String(index).padStart(4, '0')}.jpg`);
    await Promise.all(names.map((name) => writeFile(path.join(directory, name), '')));
    const start = performance.now();
    const session = await service.open([path.join(directory, names[1_000]!)]);
    const elapsed = performance.now() - start;
    expect(session.items).toHaveLength(names.length);
    expect(session.items[1_000]?.id).toBe(session.selectedId);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('returns the selected image first and publishes sibling batches without replacing its identity', async () => {
    const { directory, service } = await setup();
    const names = Array.from({ length: 2_100 }, (_, index) => `frame${String(index).padStart(4, '0')}.jpg`);
    await Promise.all(names.map((name) => writeFile(path.join(directory, name), '')));
    const updates: Awaited<ReturnType<ImageFileService['open']>>[] = [];
    const session = await service.open([path.join(directory, names[1_000]!)], (update) => updates.push(update));
    expect(session.items.map((item) => item.fileName)).toEqual([names[1_000]]);
    expect(session.complete).toBe(false);
    await vi.waitFor(() => expect(updates.at(-1)?.complete).toBe(true));
    expect(updates.flatMap((update) => update.items)).toHaveLength(names.length - 1);
    expect(updates.every((update) => update.sessionId === session.sessionId && update.selectedId === session.selectedId)).toBe(true);
    expect(service.resolve(session.selectedId)).toBe(path.join(directory, names[1_000]!));
  });

  it('opens a directory progressively and finishes after streaming every supported image', async () => {
    const { directory, service } = await setup();
    const names = Array.from({ length: 2_100 }, (_, index) => `frame${String(index).padStart(4, '0')}.jpg`);
    await Promise.all(names.map((name) => writeFile(path.join(directory, name), '')));
    const updates: Awaited<ReturnType<ImageFileService['open']>>[] = [];
    const startedAt = performance.now();
    const session = await service.open([directory], (update) => updates.push(update));
    const firstMs = performance.now() - startedAt;
    expect(session.items).toHaveLength(1);
    expect(session.complete).toBe(false);
    expect(firstMs).toBeLessThan(2_000);
    await vi.waitFor(() => expect(updates.at(-1)?.complete).toBe(true));
    expect([session.items[0], ...updates.flatMap((update) => update.items)].map((item) => item?.fileName).sort()).toEqual(names);
    expect(service.resolve(session.selectedId)).toBe(path.join(directory, session.items[0]!.fileName));
    expect(updates.length).toBeGreaterThan(1);
  });

  it('opens video alongside images for temporary browsing without indexing it as an image', async () => {
    const { directory, service } = await setup();
    const video = path.join(directory, 'clip.mp4');
    const photo = path.join(directory, 'photo.jpg');
    await writeFile(video, 'fixture');
    await writeFile(photo, 'fixture');
    const updates: Awaited<ReturnType<ImageFileService['open']>>[] = [];
    const session = await service.open([video], (update) => updates.push(update));
    expect(session.items[0]).toMatchObject({ fileName: 'clip.mp4', format: 'MP4' });
    expect(service.resolve(session.selectedId)).toBe(video);
    await vi.waitFor(() => expect(updates.at(-1)?.complete).toBe(true));
    expect(updates.flatMap((update) => update.items).map((item) => item.fileName)).toEqual(['photo.jpg']);
  });

  it('ignores unfinished discovery after a newer image is opened', async () => {
    const { directory, service } = await setup();
    const first = path.join(directory, 'first.jpg');
    const second = path.join(directory, 'second.jpg');
    await writeFile(first, '');
    await writeFile(second, '');
    const updates: string[] = [];
    const oldSession = await service.open([first], (update) => updates.push(update.sessionId!));
    const newSession = await service.open([second], () => undefined);
    const countAtReplacement = updates.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(service.resolve(oldSession.selectedId)).toBeNull();
    expect(service.resolve(newSession.selectedId)).toBe(second);
    expect(updates).toHaveLength(countAtReplacement);
  });

  it('stops a directory stream after a newer open replaces it', async () => {
    const { directory, service } = await setup();
    const firstDirectory = path.join(directory, 'first');
    const secondDirectory = path.join(directory, 'second');
    await mkdir(firstDirectory);
    await mkdir(secondDirectory);
    await Promise.all(Array.from({ length: 2_100 }, (_, index) => writeFile(path.join(firstDirectory, `photo-${index}.jpg`), '')));
    await writeFile(path.join(secondDirectory, 'selected.jpg'), '');
    const updates: string[] = [];
    const oldSession = await service.open([firstDirectory], (update) => updates.push(update.sessionId!));
    const next = await service.open([path.join(secondDirectory, 'selected.jpg')], () => undefined);
    const countAtReplacement = updates.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(updates).toHaveLength(countAtReplacement);
    expect(service.resolve(oldSession.selectedId)).toBeNull();
    expect(service.resolve(next.selectedId)).toBe(path.join(secondDirectory, 'selected.jpg'));
  });

  it('indexes progressive pages and revokes old temporary grants on replacement', async () => {
    const { directory, resolveAssetFile } = await setup();
    const index = new TemporaryMediaIndex(path.join(directory, 'temporary.sqlite'));
    const service = new ImageFileService({ resolveAssetFile }, index);
    const firstDirectory = path.join(directory, 'many');
    await mkdir(firstDirectory);
    await Promise.all(Array.from({ length: 600 }, (_, number) => writeFile(path.join(firstDirectory, `photo${String(number).padStart(4, '0')}.jpg`), '')));
    const updates: Awaited<ReturnType<ImageFileService['open']>>[] = [];
    const opened = await service.open([firstDirectory], (update) => updates.push(update));
    await vi.waitFor(() => expect(updates.at(-1)?.complete).toBe(true));
    const page = service.pageTemporary(opened.sessionId!, 500, 100);
    expect(page.totalCount).toBe(600);
    expect(page.items[0]?.fileName).toBe('photo0500.jpg');
    const formerId = page.items[0]!.id;
    expect(service.resolve(formerId)).toBe(path.join(firstDirectory, 'photo0500.jpg'));
    const replacement = path.join(directory, 'new.jpg');
    await writeFile(replacement, '');
    const next = await service.open([replacement], () => undefined);
    expect(service.resolve(formerId)).toBeNull();
    expect(service.pageTemporary(opened.sessionId!, 500, 100)).toEqual({ items: [], totalCount: 0 });
    expect(service.resolve(next.selectedId)).toBe(replacement);
    index.close();
  });
});
