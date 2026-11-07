import { describe, expect, it } from 'vitest';
import { identifyMediaFormat, isDirectPreviewImage, isSupportedImage, listMediaFormats } from './media-format-registry';

describe('media format registry', () => {
  it('keeps every extension unique and distinguishes recognition from decoding', () => {
    const extensions = listMediaFormats().flatMap((format) => format.extensions);
    expect(new Set(extensions).size).toBe(extensions.length);
    expect(isSupportedImage('photo.CR3')).toBe(true);
    expect(isDirectPreviewImage('photo.CR3')).toBe(false);
    expect(isDirectPreviewImage('photo.JPG')).toBe(true);
    expect(identifyMediaFormat('clip.MOV')).toMatchObject({ kind: 'video', potentialLiveMotion: true });
    expect(isSupportedImage('clip.MOV')).toBe(false);
    expect(identifyMediaFormat('notes.txt')).toBeNull();
  });
});
