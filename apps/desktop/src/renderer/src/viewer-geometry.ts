export type Point = { x: number; y: number };

// 100% maps one decoded image pixel to one physical display pixel.
export function actualPixelZoom(naturalWidth: number, fittedWidth: number, pixelRatio: number): number {
  return naturalWidth > 0 && fittedWidth > 0 ? naturalWidth / fittedWidth / Math.max(1, pixelRatio) : 1;
}

export function boundPan(pan: Point, zoom: number, fitted: { width: number; height: number }, viewport: { width: number; height: number }): Point {
  const x = Math.max(0, (fitted.width * zoom - viewport.width) / 2);
  const y = Math.max(0, (fitted.height * zoom - viewport.height) / 2);
  return { x: Math.max(-x, Math.min(x, pan.x)), y: Math.max(-y, Math.min(y, pan.y)) };
}

export function zoomAround(pan: Point, pointer: Point, current: number, next: number): Point {
  const ratio = next / current;
  return { x: pointer.x - (pointer.x - pan.x) * ratio, y: pointer.y - (pointer.y - pan.y) * ratio };
}
