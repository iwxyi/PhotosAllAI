import { randomUUID } from 'node:crypto';
import { lstat, rename, unlink, writeFile } from 'node:fs/promises';

type SafeWriteFileSystem = {
  lstat: typeof lstat;
  rename: typeof rename;
  unlink: typeof unlink;
  writeFile: typeof writeFile;
};

const nodeFileSystem: SafeWriteFileSystem = { lstat, rename, unlink, writeFile };

export async function replaceRegularFileSafely(
  destination: string,
  content: Uint8Array,
  fileSystem: SafeWriteFileSystem = nodeFileSystem
): Promise<void> {
  const suffix = `${process.pid}.${randomUUID()}`;
  const temporary = `${destination}.${suffix}.tmp`;
  const previous = `${destination}.${suffix}.previous`;
  let existed = false;

  try {
    const metadata = await fileSystem.lstat(destination);
    if (!metadata.isFile()) throw new Error('DESTINATION_NOT_REGULAR_FILE');
    existed = true;
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }

  await fileSystem.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  try {
    if (existed) await fileSystem.rename(destination, previous);
    try {
      await fileSystem.rename(temporary, destination);
    } catch (publishError) {
      await fileSystem.unlink(temporary).catch(() => undefined);
      if (existed) {
        try {
          await fileSystem.rename(previous, destination);
        } catch (rollbackError) {
          throw new AggregateError([publishError, rollbackError], 'FILE_REPLACE_ROLLBACK_FAILED');
        }
      }
      throw publishError;
    }
    if (existed) await fileSystem.unlink(previous);
  } catch (error) {
    await fileSystem.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
