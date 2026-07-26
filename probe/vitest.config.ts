import { defineConfig } from 'vitest/config';

/**
 * 探针自测配置。
 *
 * 自测只打 `apps/server/test/helpers/mockSydneyServer.ts` 起的模拟上游，
 * 绝不连真实 Microsoft；因此这里不需要任何真实网络相关的设置。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    restoreMocks: true,
  },
});
