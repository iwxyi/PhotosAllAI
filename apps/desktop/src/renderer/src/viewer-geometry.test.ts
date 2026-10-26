import { describe, expect, it } from 'vitest';
import { actualPixelZoom, boundPan, zoomAround } from './viewer-geometry';

describe('viewer pixel geometry', () => {
  it('distinguishes fit from actual pixels on standard and Retina displays', () => {
    expect(actualPixelZoom(6000, 1000, 1)).toBe(6);
    expect(actualPixelZoom(6000, 1000, 2)).toBe(3);
    expect(actualPixelZoom(600, 1000, 2)).toBe(.3);
    expect(actualPixelZoom(0, 0, 2)).toBe(1);
  });
  it('preserves the image point under the cursor while zooming', () => {
    const pan = { x: 20, y: -10 };
    const pointer = { x: 120, y: 90 };
    const next = zoomAround(pan, pointer, 1, 3);
    expect((pointer.x - next.x) / 3).toBe(pointer.x - pan.x);
    expect((pointer.y - next.y) / 3).toBe(pointer.y - pan.y);
  });
  it('bounds each axis independently for fit-width long images', () => {
    expect(boundPan({ x: 300, y: 2000 }, 2, { width: 200, height: 800 }, { width: 400, height: 800 })).toEqual({ x: 0, y: 400 });
    expect(boundPan({ x: 30, y: 50 }, .5, { width: 200, height: 800 }, { width: 400, height: 800 })).toEqual({ x: 0, y: 0 });
  });
});
