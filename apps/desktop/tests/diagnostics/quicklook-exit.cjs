/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Electron CommonJS entry point. */
/* global require */
const process = require("node:process");
const { Buffer } = require("node:buffer");
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const mode = process.argv[2] || 'baseline';
const root = process.argv[3];
app.disableHardwareAcceleration();
app.setPath('userData', path.join(root, 'userdata'));
const log = (phase, extra = {}) => fs.appendFileSync(path.join(root, 'trace.jsonl'), JSON.stringify({ time: Date.now(), pid: process.pid, mode, phase, ...extra }) + '\n');
log('start', { electron: process.versions.electron });
app.on('before-quit', () => log('before-quit'));
app.on('will-quit', () => log('will-quit'));
process.on('exit', (code) => log('exit', { code }));
app.whenReady().then(async () => {
  log('ready');
  if (mode.includes('sqlite')) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('create table t (id integer primary key, value text)');
    const insert = db.prepare('insert into t(value) values (?)');
    for (let i = 0; i < 10000; i++) insert.run(String(i));
    db.close();
    log('sqlite-closed');
  }
  const pending = [];
  if (mode.includes('thumbnail')) {
    for (let i = 0; i < 32; i++) {
      const file = path.join(root, `${i}.jpg`);
      fs.writeFileSync(file, mode.includes('valid') ? nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64')).toJPEG(80) : mode.includes('corrupt') ? 'not a jpeg' : '');
      log('thumbnail-start', { i });
      pending.push(nativeImage.createThumbnailFromPath(file, { width: 128, height: 128 }).then(image => log('thumbnail-done', { i, empty: image.isEmpty() }), error => log('thumbnail-error', { i, error: String(error) })));
    }
  }
  if (!mode.includes('pending')) await Promise.all(pending);
  log('quit', { pending: mode.includes('pending') });
  app.quit();
});
