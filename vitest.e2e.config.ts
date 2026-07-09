import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['e2e/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 35_000,
  },
  // Don't constrain vitest to src/ rootDir from tsconfig
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        rootDir: '.',
        types: ['node', 'electron'],
      },
    },
  },
});