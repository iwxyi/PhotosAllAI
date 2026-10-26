import { copyFile, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import exifr from 'exifr';
import { afterEach, expect, it, vi } from 'vitest';
import { ImageFileService } from './image-file-service';

vi.mock('exifr', () => ({ default: { parse: vi.fn() } }));
const directories: string[] = [];
afterEach(async () => {
  vi.mocked(exifr.parse).mockReset();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it('reads photographic and textual location metadata without deriving a city from GPS', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photo-group-exif-'));
  directories.push(directory);
  const file = path.join(directory, 'image.jpg');
  await copyFile(path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg'), file);
  const service = new ImageFileService({ resolveAssetFile: () => ({ path: file, fileName: 'image.jpg', modifiedAt: 0, sizeBytes: 0 }) });
  vi.mocked(exifr.parse).mockResolvedValueOnce({ Make: 'Sony', Model: 'A7 IV', LensMake: 'Sigma', LensModel: 'Art 35mm', City: 'Tokyo', CountryName: 'Japan', DateTimeOriginal: new Date('2024-05-12T12:00:00Z'), ExposureTime: 1 / 125, FNumber: 2.8, FocalLength: 35, ISO: 400 } as never);
  const details = await service.details('asset-id');
  expect(details).toMatchObject({ cameraMake: 'Sony', cameraModel: 'A7 IV', lensMake: 'Sigma', lensModel: 'Art 35mm', city: 'Tokyo', country: 'Japan', takenAt: '2024-05-12T12:00:00.000Z', exposureSeconds: 1 / 125, aperture: 2.8, focalLength: 35, iso: 400 });
  expect(exifr.parse).toHaveBeenCalledWith(file, expect.objectContaining({ iptc: true, xmp: true }));
  await service.details('asset-id');
  expect(exifr.parse).toHaveBeenCalledTimes(1);
  await utimes(file, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  vi.mocked(exifr.parse).mockResolvedValueOnce({ GPSLatitude: 35.6, GPSLongitude: 139.7 } as never);
  const gpsOnly = await service.details('asset-id');
  expect(gpsOnly.city).toBeUndefined();
  expect(gpsOnly.country).toBeUndefined();
});
