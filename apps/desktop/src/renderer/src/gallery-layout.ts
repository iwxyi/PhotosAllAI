export type GalleryGroup<T> = { key: string; title: string; items: T[] };
export type GalleryHeading = { key: string; title: string; count: number; top: number };
export type GalleryPosition = { top: number; left: number; width: number; height: number };

type LayoutInput<T> = {
  groups: GalleryGroup<T>[];
  grouped: boolean;
  width: number;
  targetHeight: number;
  viewportHeight: number;
  ratio: (item: T) => number;
  id: (item: T) => string;
  metadataHeight: (item: T) => number;
};

export function layoutJustified<T>({ groups, grouped, width, targetHeight, viewportHeight, ratio, id, metadataHeight }: LayoutInput<T>) {
  const sizes: Record<string, { width: number; height: number }> = {};
  const rows: Array<{ start: number; end: number; top: number; height: number }> = [];
  const headings: GalleryHeading[] = [];
  const gap = 10;
  let index = 0;
  let top = 0;
  for (const [groupIndex, group] of groups.entries()) {
    if (grouped) {
      if (groupIndex > 0) top += 14;
      headings.push({ key: group.key, title: group.title, count: group.items.length, top: top + 8 });
      top += 46;
    }
    let row: T[] = [];
    let sum = 0;
    const flush = (last: boolean) => {
      if (!row.length) return;
      const fit = (width - gap * (row.length - 1)) / sum;
      const height = Math.min(last ? targetHeight : targetHeight * 1.35, fit, Math.max(100, viewportHeight * .55));
      for (const item of row) sizes[id(item)] = { width: height * ratio(item), height };
      rows.push({ start: index, end: index + row.length, top, height: height + Math.max(...row.map(metadataHeight)) });
      index += row.length;
      top += rows.at(-1)!.height + gap;
      row = [];
      sum = 0;
    };
    for (const item of group.items) {
      const itemRatio = ratio(item);
      if (row.length && (sum + itemRatio) * targetHeight + gap * row.length > width) flush(false);
      row.push(item);
      sum += itemRatio;
    }
    flush(true);
  }
  return { sizes, rows, headings, height: top };
}

export function layoutMasonry<T>({ groups, grouped, width, targetHeight, ratio, id, metadataHeight }: LayoutInput<T>) {
  const gap = 10;
  const columnCount = Math.max(1, Math.floor((width + gap) / (targetHeight + gap)));
  const cardWidth = (width - (columnCount - 1) * gap) / columnCount;
  const heights = Array<number>(columnCount).fill(0);
  const columns: Array<Array<{ photo: T; index: number; top: number; height: number }>> = Array.from({ length: columnCount }, () => []);
  const headings: GalleryHeading[] = [];
  const positions = new Map<string, GalleryPosition>();
  let top = 0;
  let index = 0;
  for (const [groupIndex, group] of groups.entries()) {
    if (grouped && groupIndex > 0) top += 14;
    if (grouped) headings.push({ key: group.key, title: group.title, count: group.items.length, top: top + 8 });
    heights.fill(top + (grouped ? 46 : 0));
    for (const photo of group.items) {
      const height = Math.ceil(cardWidth / ratio(photo) + metadataHeight(photo));
      let column = 0;
      for (let candidate = 1; candidate < columnCount; candidate += 1) {
        if (heights[candidate]! < heights[column]!) column = candidate;
      }
      const itemTop = heights[column]! + 8;
      columns[column]!.push({ photo, index: index++, top: itemTop, height });
      positions.set(id(photo), { top: itemTop, left: 16 + column * (cardWidth + gap), width: cardWidth, height });
      heights[column] = heights[column]! + height + gap;
    }
    top = Math.max(...heights);
  }
  return { columns, headings, positions, height: top };
}
