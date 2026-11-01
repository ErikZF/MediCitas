import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/test.ts', 'tests/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      '**/dist/**',
      // Empty placeholders have no coverage. Remove each exclusion when real tests are added.
      'tests/auth/test.ts',
      'tests/race/test.ts',
    ],
    restoreMocks: true,
  },
});
