import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/test.ts', 'tests/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      '**/dist/**',
      // Empty placeholder for the booking race test (card E6). Remove when the real test is added.
      'tests/race/test.ts',
    ],
    restoreMocks: true,
  },
});
