import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
// 不引入 @testing-library/jest-dom，保持依赖最小；断言直接用 DOM API + vitest 内置 matcher。
afterEach(() => {
    cleanup();
    sessionStorage.clear();
});
