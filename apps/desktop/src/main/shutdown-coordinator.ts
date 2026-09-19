export async function settleBeforeShutdown(
  operations: readonly Promise<unknown>[],
  timeoutMs: number
): Promise<'settled' | 'timed-out'> {
  if (operations.length === 0) return 'settled';

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(operations).then(() => 'settled' as const),
      new Promise<'timed-out'>((resolve) => {
        timeout = setTimeout(() => resolve('timed-out'), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
