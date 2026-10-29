import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStartupFailureDialog, writeStartupFailureLog } from './startup-failure';

describe('startup failure dialog', () => {
  it('does not expose arbitrary startup error details', () => {
    const privateDetails = 'failed at /Users/private/Pictures/client.raw with sk-secret and https://provider.example/v1';
    const dialog = createStartupFailureDialog(new Error(privateDetails));
    const serialized = JSON.stringify(dialog);

    expect(dialog.title).toBe('PhotoAllIsAI 无法启动');
    expect(dialog.content).toContain('这是应用自身的错误提示');
    expect(serialized).not.toContain(privateDetails);
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('provider.example');
  });

  it('records the failing stage and stack locally without credentials', () => {
    const directory = mkdtempSync(join(tmpdir(), 'startup-log-'));
    try {
      const path = join(directory, 'logs', 'startup-failure.log');
      expect(writeStartupFailureLog(path, '初始化 Agent', new Error('EACCES sk-secret Bearer token https://provider.example/key'))).toBe(true);
      const log = readFileSync(path, 'utf8');
      expect(log).toContain('初始化 Agent');
      expect(log).toContain('EACCES');
      expect(log).not.toContain('sk-secret');
      expect(log).not.toContain('Bearer token');
      expect(log).not.toContain('provider.example');
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
      const dialog = createStartupFailureDialog(new Error('private'), '初始化 Agent', path);
      expect(dialog.content).toContain(path);
      expect(dialog.content).toContain('初始化 Agent');
      expect(writeStartupFailureLog(join(path, 'invalid'), '启动', new Error('failure'))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
