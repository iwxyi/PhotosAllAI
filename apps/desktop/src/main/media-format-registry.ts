import path from 'node:path';

export type MediaKind = 'image' | 'video';
export type MediaFormat = {
  id: string;
  kind: MediaKind;
  extensions: readonly string[];
  directPreview: boolean;
  potentialLiveMotion?: boolean;
};

// Recognition is deliberately separate from decoder support. A file may be
// indexed while its full-resolution preview still requires another decoder.
const formats: readonly MediaFormat[] = [
  { id: 'jpeg', kind: 'image', extensions: ['.jpg', '.jpeg'], directPreview: true, potentialLiveMotion: true },
  { id: 'png', kind: 'image', extensions: ['.png'], directPreview: true },
  { id: 'webp', kind: 'image', extensions: ['.webp'], directPreview: true },
  { id: 'gif', kind: 'image', extensions: ['.gif'], directPreview: true },
  { id: 'avif', kind: 'image', extensions: ['.avif'], directPreview: true },
  { id: 'bmp', kind: 'image', extensions: ['.bmp'], directPreview: true },
  { id: 'ico', kind: 'image', extensions: ['.ico'], directPreview: true },
  { id: 'heif', kind: 'image', extensions: ['.heic', '.heif'], directPreview: false, potentialLiveMotion: true },
  { id: 'tiff', kind: 'image', extensions: ['.tif', '.tiff'], directPreview: false },
  { id: 'raw', kind: 'image', extensions: ['.dng', '.cr2', '.cr3', '.nef', '.nrw', '.arw', '.raf', '.rw2', '.orf', '.pef'], directPreview: false },
  { id: 'quicktime', kind: 'video', extensions: ['.mov'], directPreview: false, potentialLiveMotion: true },
  { id: 'mp4', kind: 'video', extensions: ['.mp4', '.m4v'], directPreview: false, potentialLiveMotion: true },
  { id: 'webm', kind: 'video', extensions: ['.webm'], directPreview: false }
];

const byExtension = new Map<string, MediaFormat>();
for (const format of formats) {
  for (const extension of format.extensions) {
    if (byExtension.has(extension)) throw new Error(`Duplicate media extension: ${extension}`);
    byExtension.set(extension, format);
  }
}

export function listMediaFormats(): readonly MediaFormat[] { return formats; }
export function identifyMediaFormat(filePath: string): MediaFormat | null {
  return byExtension.get(path.extname(filePath).toLowerCase()) ?? null;
}
export function isSupportedImage(filePath: string): boolean {
  return identifyMediaFormat(filePath)?.kind === 'image';
}
export function isSupportedBrowseMedia(filePath: string): boolean {
  return identifyMediaFormat(filePath) !== null;
}
export function isDirectPreviewImage(filePath: string): boolean {
  const format = identifyMediaFormat(filePath);
  return format?.kind === 'image' && format.directPreview;
}
