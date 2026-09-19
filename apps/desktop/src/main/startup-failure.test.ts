import { describe, expect, it } from 'vitest';

import { createStartupFailureDialog } from './startup-failure';

describe('startup failure dialog', () => {
  it('does not expose arbitrary startup error details', () => {
    const privateDetails = 'failed at /Users/private/Pictures/client.raw with sk-secret and https://provider.example/v1';
    const dialog = createStartupFailureDialog(new Error(privateDetails));
    const serialized = JSON.stringify(dialog);

    expect(dialog.title).toBe('PhotoAllIsAI 无法启动');
    expect(dialog.content).toContain('原图和原文件夹不会被修改');
    expect(serialized).not.toContain(privateDetails);
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('provider.example');
  });
});
