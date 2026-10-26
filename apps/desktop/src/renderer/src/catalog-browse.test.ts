import { describe, expect, it } from 'vitest';
import { groupCatalogPhotos, localDateKey } from './catalog-browse';
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
});
