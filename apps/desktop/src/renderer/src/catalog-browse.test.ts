import { describe, expect, it } from 'vitest';
import { defaultGroupOrder, groupCatalogPhotos, localDateKey } from './catalog-browse';
import { photos } from './mock-data';
import type { CatalogFolder, FileDetails } from '@photoallisai/contracts';

describe('catalog browsing', () => {
  const day = new Date(2026, 0, 15, 0).getTime();
  const items = [
    { ...photos[0]!, id: '1', folderId: 'a', modifiedAt: day, format: 'JPG' },
    { ...photos[1]!, id: '2', folderId: 'b', modifiedAt: day, format: 'PNG' },
    { ...photos[2]!, id: '3', folderId: 'a', modifiedAt: day, format: 'JPG' }
  ];
  const folders: CatalogFolder[] = ['a', 'b'].map((id) => ({ id, name: 'same name', assetCount: 2, offlineCount: 0, parentId: null, rootId: id, depth: 0, isRoot: true }));
  it('uses local dates and preserves every enabled dimension without merging same-name folders', () => {
    expect(localDateKey(day)).toBe('2026-01-15');
    const groups = groupCatalogPhotos(items, ['date', 'month', 'folder'], folders);
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.items[0]?.id === '1')?.items.map((item) => item.id)).toEqual(['1', '3']);
    expect(groups[0]?.title).toBe('2026-01-15 · 2026-01 · same name');
    expect(groups.flatMap((group) => group.items)).toHaveLength(items.length);
    expect(groupCatalogPhotos(items, [], folders)[0]?.items).toEqual(items);
  });
  it('sorts every group by its active dimensions without removing photos', () => {
    const withLaterDate = [...items, { ...items[0]!, id: '4', modifiedAt: new Date(2026, 1, 15).getTime() }];
    expect(groupCatalogPhotos(withLaterDate, ['month'], folders).map((group) => group.title)).toEqual(['2026-02', '2026-01']);
    expect(groupCatalogPhotos(withLaterDate, ['month'], folders, { month: 'asc' }).map((group) => group.title)).toEqual(['2026-01', '2026-02']);
    const byFolder = groupCatalogPhotos(withLaterDate, ['folder', 'month'], folders, { folder: 'asc', month: 'desc' });
    expect(byFolder.map((group) => group.items.map((item) => item.id))).toEqual([['4'], ['1', '3'], ['2']]);
    expect(byFolder.flatMap((group) => group.items).map((item) => item.id).sort()).toEqual(['1', '2', '3', '4']);
  });
  it('groups file properties, labels and independent EXIF fields in any order', () => {
    const camera: FileDetails = { path: '/one.jpg', sizeBytes: 12 * 1024 ** 2, modifiedAt: day, takenAt: '2024-05-12T12:00:00.000Z', lensMake: 'Sigma', lensModel: 'Art 35mm', cameraModel: 'A7 IV', aperture: 2.8, focalLength: 35, exposureSeconds: 1 / 125, exposure: '1/125 s', iso: 400, city: 'Tokyo', country: 'Japan' };
    const decorated = [
      { ...items[0]!, fileName: 'Alpha.jpg', sizeBytes: 12 * 1024 ** 2, rating: 5, labelColor: 'green' as const, flag: 'picked' as const, favorite: true },
      { ...items[1]!, fileName: 'Beta.png', sizeBytes: 500_000, rating: 0, labelColor: null, flag: 'unflagged' as const, favorite: false }
    ];
    const metadata = { '1': camera, '2': null };
    expect(groupCatalogPhotos(decorated, ['firstLetter', 'size'], folders).map((group) => group.title)).toEqual(['A · 10–100 MB', 'B · < 1 MB']);
    expect(groupCatalogPhotos(decorated, ['rating', 'color', 'flag', 'favorite'], folders)[0]?.title).toBe('5 星 · 绿色 · 留用 · 已收藏');
    const exif = groupCatalogPhotos(decorated, ['country', 'city', 'exifLensMake', 'exifLensModel', 'exifYear', 'exifMonth', 'exifDay', 'exifAperture', 'exifFocalLength', 'exifExposure', 'exifIso', 'cameraModel'], folders, {}, metadata);
    expect(exif).toHaveLength(2);
    expect(exif[0]?.title).toBe('Japan · Tokyo · Sigma · Art 35mm · 2024 · 05 月 · 12 日 · f/2.8 · 35 mm · 1/125 s · ISO 400 · A7 IV');
    expect(exif[1]?.title).toContain('未知国家 · 未知城市');
    expect(groupCatalogPhotos(decorated, ['exifIso', 'country'], folders, { exifIso: 'desc' }, metadata).map((group) => group.items[0]?.id)).toEqual(['1', '2']);
    expect(groupCatalogPhotos(decorated, ['country', 'exifIso'], folders, {}, metadata).map((group) => group.items[0]?.id)).toEqual(['1', '2']);
    expect(groupCatalogPhotos(decorated, ['exifExposure'], folders, {}, { '1': camera, '2': { ...camera, exposureSeconds: .02, exposure: '1/50 s' } }).map((group) => group.title)).toEqual(['1/125 s', '1/50 s']);
  });
  it('groups actual aspect ratios and orientation independently in either direction', () => {
    const sizes = [[2500, 1000], [1500, 1000], [3000, 2000], [1000, 1000], [700, 1000], [400, 1000], [1800, 2251], null] as const;
    const samples = sizes.map((size, index) => ({ ...items[0]!, id: String(index) }));
    const metadata = Object.fromEntries(sizes.map((size, index) => [String(index), size === null ? null : { path: '/photo.jpg', sizeBytes: 10, modifiedAt: day, width: size[0], height: size[1] }])) as Record<string, FileDetails | null>;
    expect(defaultGroupOrder('aspectRatio')).toBe('desc');
    expect(defaultGroupOrder('orientation')).toBe('desc');
    expect(groupCatalogPhotos(samples, ['aspectRatio'], folders, {}, metadata).map((group) => group.title)).toEqual(['5:2', '3:2', '1:1', '4:5', '7:10', '2:5', '未知比例']);
    expect(groupCatalogPhotos(samples, ['aspectRatio'], folders, { aspectRatio: 'asc' }, metadata).map((group) => group.title)).toEqual(['2:5', '7:10', '4:5', '1:1', '3:2', '5:2', '未知比例']);
    expect(groupCatalogPhotos(samples, ['orientation'], folders, {}, metadata).map((group) => group.title)).toEqual(['横图', '方图', '竖图', '未知方向']);
    expect(groupCatalogPhotos(samples, ['orientation'], folders, { orientation: 'asc' }, metadata).map((group) => group.title)).toEqual(['竖图', '方图', '横图', '未知方向']);
    expect(groupCatalogPhotos(samples, ['orientation', 'aspectRatio'], folders, {}, metadata).map((group) => group.title)).toEqual(['横图 · 5:2', '横图 · 3:2', '方图 · 1:1', '竖图 · 4:5', '竖图 · 7:10', '竖图 · 2:5', '未知方向 · 未知比例']);
  });
});
