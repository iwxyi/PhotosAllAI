import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clipboard } from 'electron';

const MAC_FILE_CLIPBOARD_SCRIPT = `ObjC.import('AppKit');
ObjC.import('Foundation');
function run() {
  var input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  var paths = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)));
  var pasteboard = $.NSPasteboard.generalPasteboard;
  pasteboard.clearContents;
  if (!ObjC.unwrap(pasteboard.setPropertyListForType($(paths), $.NSFilenamesPboardType))) throw new Error('CLIPBOARD_WRITE_FAILED');
  return String(ObjC.deepUnwrap(pasteboard.propertyListForType($.NSFilenamesPboardType)).length);
}`;
const WINDOWS_FILE_CLIPBOARD_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$stream = [Console]::OpenStandardInput()
$buffer = [System.IO.MemoryStream]::new()
$stream.CopyTo($buffer)
$filePaths = [System.Text.Encoding]::Unicode.GetString($buffer.ToArray()) | ConvertFrom-Json
$paths = [System.Collections.Specialized.StringCollection]::new()
$filePaths | ForEach-Object { [void]$paths.Add($_) }
[System.Windows.Forms.Clipboard]::SetFileDropList($paths)`;
const MAC_READ_FILES_SCRIPT = `ObjC.import('AppKit');
function run() {
  var items = $.NSPasteboard.generalPasteboard.pasteboardItems;
  var urls = [];
  for (var index = 0; index < items.count; index++) {
    var value = items.objectAtIndex(index).stringForType($.NSPasteboardTypeFileURL);
    if (value) urls.push(ObjC.unwrap(value));
  }
  var paths = ObjC.deepUnwrap($.NSPasteboard.generalPasteboard.propertyListForType($.NSFilenamesPboardType));
  if (paths && paths.length) return JSON.stringify(paths.map(function(path) { return ObjC.unwrap($.NSURL.fileURLWithPath($(path)).absoluteString); }));
  return JSON.stringify(urls);
}`;
const WINDOWS_READ_FILES_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
  @([System.Windows.Forms.Clipboard]::GetFileDropList()) | ConvertTo-Json -Compress
} else { '[]' }`;

export function readFilesFromClipboard(platform = process.platform): string[] {
  if (platform === 'darwin') {
    const output = execFileSync('osascript', ['-l', 'JavaScript', '-e', MAC_READ_FILES_SCRIPT], { encoding: 'utf8', timeout: 5_000 });
    const urls = JSON.parse(output.trim()) as string[];
    return urls.filter((url) => url.startsWith('file:')).map((url) => fileURLToPath(url));
  }
  if (platform === 'win32') {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', WINDOWS_READ_FILES_SCRIPT], { encoding: 'utf8', timeout: 10_000 });
    const paths = JSON.parse(output.trim()) as string[] | string;
    return Array.isArray(paths) ? paths : [paths];
  }
  for (const format of ['x-special/gnome-copied-files', 'text/uri-list']) {
    const data = clipboard.readBuffer(format).toString('utf8');
    const urls = data.split(/\r?\n/u).filter((line) => line.startsWith('file:'));
    if (urls.length) return urls.map((url) => fileURLToPath(url));
  }
  return [];
}

export function writeFilesToClipboard(paths: string[], platform = process.platform): void {
  const unique = [...new Set(paths)];
  if (unique.length === 0) throw new Error('CLIPBOARD_FILES_EMPTY');
  const urls = unique.map((filePath) => pathToFileURL(filePath).href);
  if (platform === 'darwin') {
    const count = execFileSync('osascript', ['-l', 'JavaScript', '-e', MAC_FILE_CLIPBOARD_SCRIPT], { input: JSON.stringify(unique), timeout: 5_000, encoding: 'utf8' });
    if (Number(count.trim()) !== unique.length) throw new Error('CLIPBOARD_WRITE_INCOMPLETE');
    return;
  }
  if (platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', WINDOWS_FILE_CLIPBOARD_SCRIPT], { input: Buffer.from(JSON.stringify(unique), 'utf16le'), timeout: 10_000 });
    return;
  }
  const gnomeFormat = 'x-special/gnome-copied-files';
  const uriFormat = 'text/uri-list';
  const gnome = Buffer.from(`copy\n${urls.join('\n')}`);
  const uriList = Buffer.from(urls.join('\r\n'));
  clipboard.writeBuffer(gnomeFormat, gnome);
  clipboard.writeBuffer(uriFormat, uriList);
  if (!clipboard.availableFormats().includes(gnomeFormat) && /GNOME|CINNAMON|MATE|XFCE/iu.test(process.env.XDG_CURRENT_DESKTOP ?? '')) {
    clipboard.writeBuffer(gnomeFormat, gnome);
  }
}
