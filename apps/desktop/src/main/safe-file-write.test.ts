import * as fileSystem from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { publishTemporaryFileSafely, replaceRegularFileSafely } from './safe-file-write';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<{ root: string; destination: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-safe-write-'));
  roots.push(root);
  return { root, destination: path.join(root, 'diagnostics.json') };
}

describe('safe user-selected file replacement', () => {
  it('replaces a regular file and removes transaction artifacts', async () => {
    const { root, destination } = await fixture();
    await writeFile(destination, 'previous');

    await replaceRegularFileSafely(destination, Buffer.from('next'));

    expect(await readFile(destination, 'utf8')).toBe('next');
    expect(await readdir(root)).toEqual(['diagnostics.json']);
  });

  it('restores the previous file when publishing the temporary file fails', async () => {
    const { root, destination } = await fixture();
    await writeFile(destination, 'previous');
    let renameCalls = 0;
    const rename = vi.fn(async (...[source, target]: Parameters<typeof fileSystem.rename>) => {
      renameCalls += 1;
      if (renameCalls === 2) throw Object.assign(new Error('simulated publish failure'), { code: 'EACCES' });
      await fileSystem.rename(source, target);
    });

    await expect(replaceRegularFileSafely(destination, Buffer.from('next'), {
      lstat: fileSystem.lstat,
      rename,
      unlink: fileSystem.unlink,
      writeFile: fileSystem.writeFile
    })).rejects.toThrow('simulated publish failure');

    expect(await readFile(destination, 'utf8')).toBe('previous');
    expect(await readdir(root)).toEqual(['diagnostics.json']);
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it('publishes an existing temporary file over a regular destination', async () => {
    const { root, destination } = await fixture();
    const temporary = `${destination}.producer.tmp`;
    await writeFile(destination, 'previous');
    await writeFile(temporary, 'next');

    await publishTemporaryFileSafely(destination, temporary);

    expect(await readFile(destination, 'utf8')).toBe('next');
    expect(await readdir(root)).toEqual(['diagnostics.json']);
  });

  it('removes a partially written temporary file when staging fails', async () => {
    const { root, destination } = await fixture();
    const writeFileWithFailure = vi.fn(async (...[target]: Parameters<typeof fileSystem.writeFile>) => {
      await fileSystem.writeFile(target, 'partial');
      throw Object.assign(new Error('simulated disk failure'), { code: 'ENOSPC' });
    }) as typeof fileSystem.writeFile;

    await expect(replaceRegularFileSafely(destination, Buffer.from('next'), {
      lstat: fileSystem.lstat,
      rename: fileSystem.rename,
      unlink: fileSystem.unlink,
      writeFile: writeFileWithFailure
    })).rejects.toThrow('simulated disk failure');

    expect(await readdir(root)).toEqual([]);
  });

  it('does not follow a symbolic-link destination', async () => {
    const { root, destination } = await fixture();
    const outside = path.join(root, 'outside.json');
    await writeFile(outside, 'outside');
    await symlink(outside, destination);

    await expect(replaceRegularFileSafely(destination, Buffer.from('next')))
      .rejects.toThrow('DESTINATION_NOT_REGULAR_FILE');
    expect(await readFile(outside, 'utf8')).toBe('outside');
  });
});
