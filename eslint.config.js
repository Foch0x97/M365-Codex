import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * ESLint 扁平配置。
 *
 * 类型感知规则只对 `src` 生效（它们在 tsconfig 项目内）；测试文件走非类型感知规则，
 * 其类型正确性由 `npm run typecheck` 中的 tsconfig.test.json 单独保证。
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.tsbuildinfo'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Fastify 的 handler / hook 契约就是「返回 Promise」，大量处理器天然没有 await，
      // 强制它们改写成同步函数只会让路由风格割裂
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['**/test/**/*.ts', '**/*.config.ts', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      // 展开 disableTypeChecked 自带的规则关闭项，再叠加本项目的放宽项，
      // 直接写 rules 会整体覆盖上面的展开结果
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
