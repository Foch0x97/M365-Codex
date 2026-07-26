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
    // dev/ 下是开发与验收用的独立脚本（模拟上游、播种假账号），不进生产镜像，
    // 也不在任何 tsconfig 项目里；用非类型感知规则检查即可
    files: ['dev/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // 这些 .mjs 不属于任何 tsconfig 项目，必须关掉 projectService，
      // 否则解析器会因为「找不到所属项目」直接报解析错误
      parserOptions: { projectService: false, project: false },
      // 这里不引 globals 包，只声明这几个脚本实际用到的 Node 全局
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // 这些脚本就是命令行工具，输出全靠 console
      'no-console': 'off',
    },
  },
  {
    files: ['**/test/**/*.ts', '**/test/**/*.tsx', '**/*.config.ts', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      // 展开 disableTypeChecked 自带的规则关闭项，再叠加本项目的放宽项，
      // 直接写 rules 会整体覆盖上面的展开结果
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-non-null-assertion': 'off',
      // 测试里 `vi.importActual<typeof import('../api')>()` 是 Vitest 的标准写法，
      // 这里的内联 import() 类型注解没有等价的 import type 形式，放行
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', disallowTypeAnnotations: false },
      ],
    },
  },
);
