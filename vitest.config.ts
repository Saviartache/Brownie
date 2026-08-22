import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Absolute path to a workspace source entry point. */
const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Tests run against sources, not against dist/. That keeps a test run
  // independent of build order and makes coverage line numbers match the files
  // you are editing. Order matters: the more specific entry point first.
  resolve: {
    alias: [
      {
        find: /^@brownie\/protocol\/bundled$/,
        replacement: src('./packages/protocol/src/bundled.ts'),
      },
      { find: /^@brownie\/protocol$/, replacement: src('./packages/protocol/src/index.ts') },
      { find: /^@brownie\/ipc$/, replacement: src('./packages/ipc/src/index.ts') },
      { find: /^@brownie\/plugin-api$/, replacement: src('./packages/plugin-api/src/index.ts') },
      { find: /^@brownie\/gamedata-tool$/, replacement: src('./tools/gamedata/src/index.ts') },
    ],
  },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/runtime/test/**/*.test.ts',
      'tools/*/test/**/*.test.ts',
    ],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/runtime/src/**', 'tools/*/src/**'],
      reporter: ['text', 'html'],
    },
  },
});
