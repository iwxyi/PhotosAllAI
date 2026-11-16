export function exifOrientation(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1 && value <= 8 ? value : null;
  if (typeof value !== 'string') return null;
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 8) return numeric;
  const normalized = value.toLowerCase();
  if (!normalized.includes('rotate')) return null;
  if (normalized.includes('270')) return normalized.includes('mirror') ? 7 : 8;
  if (normalized.includes('90')) return normalized.includes('mirror') ? 5 : 6;
  if (normalized.includes('180')) return 3;
  return null;
}

export function swapsDimensions(orientation: number | null): boolean {
  return orientation !== null && orientation >= 5 && orientation <= 8;
}
