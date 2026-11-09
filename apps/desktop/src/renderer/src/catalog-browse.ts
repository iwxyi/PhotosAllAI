import type { CatalogFolder, FileDetails } from '@photoallisai/contracts';
import type { Photo } from './mock-data';

export const browseDimensions = {
  firstLetter: { label: '首字母', section: 'file' },
  format: { label: '格式', section: 'file' },
  year: { label: '年份', section: 'file' },
  month: { label: '月份', section: 'file' },
  date: { label: '日期', section: 'file' },
  city: { label: '城市', section: 'file' },
  country: { label: '国家', section: 'file' },
  rating: { label: '评分', section: 'file' },
  size: { label: '大小', section: 'file' },
  aspectRatio: { label: '比例', section: 'file' },
  orientation: { label: '横竖', section: 'file' },
  folder: { label: '文件夹', section: 'file' },
  exifLensMake: { label: '镜头制造商', section: 'exif' },
  exifLensModel: { label: '镜头型号', section: 'exif' },
  exifYear: { label: '拍摄年', section: 'exif' },
  exifMonth: { label: '拍摄月', section: 'exif' },
  exifDay: { label: '拍摄日', section: 'exif' },
  exifAperture: { label: '光圈', section: 'exif' },
  exifFocalLength: { label: '焦距', section: 'exif' },
  exifExposure: { label: '曝光时间', section: 'exif' },
  exifIso: { label: 'ISO 感光度', section: 'exif' },
  cameraModel: { label: '相机型号', section: 'exif' },
  color: { label: '颜色标签', section: 'file' },
  flag: { label: '旗标', section: 'file' },
  favorite: { label: '收藏', section: 'file' }
} as const;
export type BrowseDimension = keyof typeof browseDimensions;
export type BrowseFilters = {
  groupBy: BrowseDimension[];
  groupOrder: Partial<Record<BrowseDimension, 'asc' | 'desc'>>;
};
export const emptyBrowseFilters: BrowseFilters = { groupBy: [], groupOrder: {} };
export const browseLabels = Object.fromEntries(Object.entries(browseDimensions).map(([key, value]) => [key, value.label])) as Record<BrowseDimension, string>;
export const metadataDimensions = new Set<BrowseDimension>(['aspectRatio', 'orientation', 'city', 'country', 'exifLensMake', 'exifLensModel', 'exifYear', 'exifMonth', 'exifDay', 'exifAperture', 'exifFocalLength', 'exifExposure', 'exifIso', 'cameraModel']);
const descendingDimensions = new Set<BrowseDimension>(['year', 'month', 'date', 'rating', 'aspectRatio', 'orientation', 'exifYear', 'exifMonth', 'exifDay']);

export function defaultGroupOrder(dimension: BrowseDimension): 'asc' | 'desc' {
  return descendingDimensions.has(dimension) ? 'desc' : 'asc';
}

export function localDateKey(timestamp: number, precision: 'year' | 'month' | 'day' = 'day'): string {
  const date = new Date(timestamp);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return precision === 'year' ? year : precision === 'month' ? `${year}-${month}` : `${year}-${month}-${String(date.getDate()).padStart(2, '0')}`;
}

type GroupPart = { key: string; label: string; sort: string | number; missing?: boolean };
const unknown = (label: string): GroupPart => ({ key: '', label: `未知${label}`, sort: '', missing: true });
const part = (value: string | number | null | undefined, label = String(value ?? '')): GroupPart => value === null || value === undefined || value === '' ? unknown('信息') : { key: String(value), label, sort: value };
const formatNumber = (value: number) => Number(value.toFixed(2)).toString();
const commonRatios = [[3, 1], [21, 9], [2, 1], [16, 9], [3, 2], [4, 3], [5, 4], [1, 1], [4, 5], [3, 4], [2, 3], [9, 16], [1, 2], [1, 3]] as const;
const gcd = (left: number, right: number): number => right ? gcd(right, left % right) : left;
const imageRatio = (details?: FileDetails | null): number | null => {
  const width = details?.width;
  const height = details?.height;
  return width && height && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? width / height : null;
};

function ratioPart(details?: FileDetails | null): GroupPart {
  const ratio = imageRatio(details);
  if (ratio === null) return unknown('比例');
  const common = commonRatios.find(([width, height]) => Math.abs(ratio - width / height) / (width / height) <= .005);
  const width = common?.[0] ?? Math.round(details!.width!);
  const height = common?.[1] ?? Math.round(details!.height!);
  const divisor = gcd(width, height);
  const label = `${width / divisor}:${height / divisor}`;
  return { key: label, label, sort: width / height };
}

function groupPart(photo: Photo, dimension: BrowseDimension, folders: Map<string, CatalogFolder>, details?: FileDetails | null, folderLabel?: (id: string) => string): GroupPart {
  const datePart = (value: number | undefined, precision: 'year' | 'month' | 'day', missing: string) => value === undefined || !Number.isFinite(value) ? unknown(missing) : part(localDateKey(value, precision));
  const shot = details?.takenAt ? new Date(details.takenAt).getTime() : NaN;
  switch (dimension) {
    case 'firstLetter': {
      const initial = Array.from(photo.fileName.trim())[0]?.toLocaleUpperCase() ?? '';
      const key = /^\p{L}$/u.test(initial) ? initial : /^\p{N}$/u.test(initial) ? '0-9' : '#';
      return part(key);
    }
    case 'format': return part(photo.format.toUpperCase());
    case 'year': return datePart(photo.modifiedAt, 'year', '年份');
    case 'month': return datePart(photo.modifiedAt, 'month', '月份');
    case 'date': return datePart(photo.modifiedAt, 'day', '日期');
    case 'city': return details?.city ? part(details.city) : unknown('城市');
    case 'country': return details?.country ? part(details.country) : unknown('国家');
    case 'rating': return part(photo.rating, photo.rating === 0 ? '未评分' : `${photo.rating} 星`);
    case 'size': {
      const size = photo.sizeBytes;
      if (size === undefined) return unknown('大小');
      const bucket = size < 1024 ** 2 ? 0 : size < 10 * 1024 ** 2 ? 1 : size < 100 * 1024 ** 2 ? 2 : 3;
      return part(bucket, ['< 1 MB', '1–10 MB', '10–100 MB', '≥ 100 MB'][bucket]!);
    }
    case 'aspectRatio': return ratioPart(details);
    case 'orientation': {
      const ratio = imageRatio(details);
      if (ratio === null) return unknown('方向');
      const bucket = ratio > 1.05 ? 3 : ratio < .95 ? 1 : 2;
      return part(bucket, ({ 3: '横图', 2: '方图', 1: '竖图' } as const)[bucket as 1 | 2 | 3]);
    }
    case 'folder': return photo.folderId ? { key: photo.folderId, label: folderLabel?.(photo.folderId) || '未知文件夹', sort: folderLabel?.(photo.folderId) ?? '' } : unknown('文件夹');
    case 'exifLensMake': return details?.lensMake ? part(details.lensMake) : unknown('镜头制造商');
    case 'exifLensModel': return details?.lensModel || details?.lens ? part(details.lensModel ?? details.lens) : unknown('镜头型号');
    case 'exifYear': return datePart(Number.isFinite(shot) ? shot : undefined, 'year', '拍摄年');
    case 'exifMonth': return datePart(Number.isFinite(shot) ? shot : undefined, 'month', '拍摄月');
    case 'exifDay': return datePart(Number.isFinite(shot) ? shot : undefined, 'day', '拍摄日');
    case 'exifAperture': return details?.aperture ? part(details.aperture, `f/${formatNumber(details.aperture)}`) : unknown('光圈');
    case 'exifFocalLength': return details?.focalLength ? part(details.focalLength, `${formatNumber(details.focalLength)} mm`) : unknown('焦距');
    case 'exifExposure': return details?.exposureSeconds ? part(details.exposureSeconds, details.exposure ?? `${formatNumber(details.exposureSeconds)} s`) : unknown('曝光时间');
    case 'exifIso': return details?.iso ? part(details.iso, `ISO ${formatNumber(details.iso)}`) : unknown('ISO');
    case 'cameraModel': return details?.cameraModel || details?.camera ? part(details.cameraModel ?? details.camera) : unknown('相机型号');
    case 'color': return photo.labelColor ? part(photo.labelColor, ({ red: '红色', yellow: '黄色', green: '绿色', blue: '蓝色', purple: '紫色' } as const)[photo.labelColor]) : part('none', '无颜色标签');
    case 'flag': return part(photo.flag ?? 'unflagged', photo.flag === 'picked' ? '留用' : photo.flag === 'rejected' ? '排除' : '无旗标');
    case 'favorite': return part(photo.favorite ? 'yes' : 'no', photo.favorite ? '已收藏' : '未收藏');
  }
}

export function groupCatalogPhotos(photos: Photo[], dimensions: BrowseDimension[], folders: CatalogFolder[], order: BrowseFilters['groupOrder'] = {}, metadata: Record<string, FileDetails | null> = {}, selectedFolderIds: string[] = []): { key: string; title: string; items: Photo[] }[] {
  if (!dimensions.length) return [{ key: 'all', title: '', items: photos }];
  const folderMap = new Map(folders.map((folder) => [folder.id, folder]));
  const ancestorIds = (id: string): string[] => {
    const ids: string[] = [];
    let folder = folderMap.get(id);
    while (folder) { ids.push(folder.id); folder = folder.parentId ? folderMap.get(folder.parentId) : undefined; }
    return ids;
  };
  const selectedBase = selectedFolderIds.length ? ancestorIds(selectedFolderIds[0]!).find((id) => selectedFolderIds.every((selectedId) => ancestorIds(selectedId).includes(id))) : undefined;
  const paths = new Map<string, string>();
  for (const id of new Set(photos.map((photo) => photo.folderId).filter((id): id is string => Boolean(id)))) {
    const names: string[] = [];
    let folder = folderMap.get(id);
    while (folder && folder.id !== selectedBase && !folder.isRoot) {
      names.unshift(folder.name);
      folder = folder.parentId ? folderMap.get(folder.parentId) : undefined;
    }
    paths.set(id, names.join(' / ') || (selectedBase ? '当前文件夹' : '根目录'));
  }
  const labels = [...new Set([...paths.values()].filter((value) => value !== '当前文件夹' && value !== '根目录'))];
  let commonPrefix = labels.length > 1 ? labels[0]! : '';
  for (const label of labels.slice(1)) {
    while (commonPrefix && !label.startsWith(commonPrefix)) commonPrefix = commonPrefix.slice(0, -1);
  }
  if (labels.some((label) => label.length === commonPrefix.length)) commonPrefix = '';
  const folderLabel = (id: string) => {
    const label = paths.get(id) ?? '';
    return commonPrefix && label !== '当前文件夹' && label !== '根目录' ? label.slice(commonPrefix.length) : label;
  };
  const groups = new Map<string, { key: string; title: string; items: Photo[]; parts: GroupPart[] }>();
  for (const photo of photos) {
    const parts = dimensions.map((dimension) => groupPart(photo, dimension, folderMap, metadata[photo.id], folderLabel));
    const key = JSON.stringify(parts.map((value) => value.key));
    const title = parts.map((value, index) => {
      if (value.missing) return value.label;
      const dimension = dimensions[index]!;
      const earlier = dimensions.slice(0, index);
      if (dimension === 'month' && earlier.includes('year')) return `${value.key.slice(5)} 月`;
      if (dimension === 'date' && earlier.includes('month')) return `${value.key.slice(8)} 日`;
      if (dimension === 'date' && earlier.includes('year')) return value.key.slice(5);
      if (dimension === 'exifMonth' && earlier.includes('exifYear')) return `${value.key.slice(5)} 月`;
      if (dimension === 'exifDay' && earlier.includes('exifMonth')) return `${value.key.slice(8)} 日`;
      if (dimension === 'exifDay' && earlier.includes('exifYear')) return value.key.slice(5);
      return value.label;
    }).join(' · ');
    const group = groups.get(key) ?? { key, title, items: [], parts };
    group.items.push(photo);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => {
    for (let index = 0; index < dimensions.length; index++) {
      const a = left.parts[index]!;
      const b = right.parts[index]!;
      if (a.missing !== b.missing) return a.missing ? 1 : -1;
      const direction = (order[dimensions[index]!] ?? defaultGroupOrder(dimensions[index]!)) === 'asc' ? 1 : -1;
      const comparison = typeof a.sort === 'number' && typeof b.sort === 'number' ? a.sort - b.sort : String(a.sort).localeCompare(String(b.sort), undefined, { numeric: true, sensitivity: 'base' });
      if (comparison) return comparison * direction;
    }
    return 0;
  }).map(({ key, title, items }) => ({ key, title, items }));
}
