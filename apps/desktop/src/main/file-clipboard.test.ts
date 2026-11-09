import { execFileSync } from 'node:child_process';
import { clipboard } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { readFilesFromClipboard, writeFilesToClipboard } from './file-clipboard';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('electron', () => ({ clipboard: { writeBuffer: vi.fn(), readBuffer: vi.fn(), availableFormats: vi.fn() } }));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it('writes every macOS file as a separate pasteboard item, including non-ASCII paths', () => {
  vi.mocked(execFileSync).mockReturnValue('2');
  writeFilesToClipboard(['/tmp/照片 A.jpg', '/tmp/clip.mov', '/tmp/照片 A.jpg'], 'darwin');
  expect(execFileSync).toHaveBeenCalledTimes(1);
  const [command, args, options] = vi.mocked(execFileSync).mock.calls[0]!;
  expect(command).toBe('osascript');
  expect(args).toContain('-e');
  expect((args as string[]).join(' ')).toContain('NSFilenamesPboardType');
  expect(JSON.parse(String(options?.input))).toEqual(['/tmp/照片 A.jpg', '/tmp/clip.mov']);
});

it('sends the complete Windows file list as UTF-16 to the native file-drop clipboard API', () => {
  writeFilesToClipboard(['C:\\照片\\a.jpg', 'C:\\照片\\b.mp4'], 'win32');
  const [command, args, options] = vi.mocked(execFileSync).mock.calls[0]!;
  expect(command).toBe('powershell.exe');
  expect((args as string[]).join(' ')).toContain('SetFileDropList');
  expect(JSON.parse((options?.input as Buffer).toString('utf16le'))).toEqual(['C:\\照片\\a.jpg', 'C:\\照片\\b.mp4']);
});

it('keeps the GNOME file list when a second clipboard write replaces the first', () => {
  vi.stubEnv('XDG_CURRENT_DESKTOP', 'GNOME');
  vi.mocked(clipboard.availableFormats).mockReturnValue(['text/uri-list']);
  writeFilesToClipboard(['/tmp/a.jpg', '/tmp/b.mov'], 'linux');
  expect(vi.mocked(clipboard.writeBuffer).mock.calls.map(([format]) => format)).toEqual([
    'x-special/gnome-copied-files', 'text/uri-list', 'x-special/gnome-copied-files'
  ]);
  expect(vi.mocked(clipboard.writeBuffer).mock.calls[2]?.[1].toString()).toBe('copy\nfile:///tmp/a.jpg\nfile:///tmp/b.mov');
});

it('reads every macOS file URL from the pasteboard', () => {
  vi.mocked(execFileSync).mockReturnValue('["file:///tmp/a%20b.jpg","file:///tmp/clip.mov"]');
  expect(readFilesFromClipboard('darwin')).toEqual(['/tmp/a b.jpg', '/tmp/clip.mov']);
});

it('reads Linux file URLs and ignores the copy marker', () => {
  vi.mocked(clipboard.readBuffer).mockReturnValue(Buffer.from('copy\nfile:///tmp/a.jpg\nfile:///tmp/b.mov'));
  expect(readFilesFromClipboard('linux')).toEqual(['/tmp/a.jpg', '/tmp/b.mov']);
});

it('reads a Windows file-drop list', () => {
  vi.mocked(execFileSync).mockReturnValue('["C:\\\\Photos\\\\a.jpg","C:\\\\Photos\\\\b.mp4"]');
  expect(readFilesFromClipboard('win32')).toEqual(['C:\\Photos\\a.jpg', 'C:\\Photos\\b.mp4']);
});
