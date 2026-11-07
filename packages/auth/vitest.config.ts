import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/test.ts', 'tests/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      '**/dist/**',
      // Empty placeholder kept for the permission-matrix tests (card J1). Remove when real tests are added.
      'tests/test.ts',
    ],
    restoreMocks: true,
  },
});
