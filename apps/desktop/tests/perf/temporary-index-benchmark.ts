import { TemporaryMediaIndex } from '../../src/main/temporary-media-index.ts';

const count = Number(process.argv[2] ?? 100_000);
if (!Number.isSafeInteger(count) || count < 1 || count > 2_000_000) throw new RangeError('count must be 1..2,000,000');
const index = new TemporaryMediaIndex();
index.begin('benchmark');
const memory = () => {
  global.gc?.();
  const usage = process.memoryUsage();
  return { heapMiB: Math.round(usage.heapUsed / 1024 ** 2), rssMiB: Math.round(usage.rss / 1024 ** 2) };
};
const initial = memory();
const insertedAt = performance.now();
for (let start = 0; start < count; start += 500) {
  index.insert('benchmark', Array.from({ length: Math.min(500, count - start) }, (_, offset) => {
    const number = count - 1 - start - offset;
    return { id: `id-${number}`, file: `/photos/photo${String(number).padStart(7, '0')}.jpg` };
  }));
}
const insertionMs = Math.round(performance.now() - insertedAt);
const inserted = memory();
let ticks = 0;
const timer = setInterval(() => { ticks += 1; }, 1);
const sortedAt = performance.now();
await index.finishAsync('benchmark');
clearInterval(timer);
const sortingMs = Math.round(performance.now() - sortedAt);
const sorted = memory();
const pageAt = performance.now();
const page = index.page('benchmark', count - Math.min(count, 250), Math.min(count, 250));
const pageMs = Math.round((performance.now() - pageAt) * 100) / 100;
console.log(JSON.stringify({ count, initial, inserted, sorted, insertionMs, sortingMs, ticks, pageMs, first: page.items[0]?.fileName, last: page.items.at(-1)?.fileName }));
index.close();
