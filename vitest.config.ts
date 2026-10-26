import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/desktop/src/main/**/*.test.ts', 'apps/desktop/src/renderer/src/task-batches.test.ts', 'apps/desktop/src/renderer/src/viewer-geometry.test.ts', 'apps/desktop/src/renderer/src/catalog-browse.test.ts'],
    coverage: { reporter: ['text', 'html'] }
  }
});
