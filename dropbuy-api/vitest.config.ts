import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    env: { DATABASE_URL: 'file:./test.db', JWT_SECRET: 'test-secret', DEFAULT_TENANT_FX_HASH: 'afa4cf0301eb4a75882dd5df30cc54a5', NODE_ENV: 'test' },
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
