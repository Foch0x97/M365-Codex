import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
// 开发代理目标可用 VITE_API_TARGET 覆盖，默认打到本机 8080（服务端默认端口）。
export default defineConfig(({ mode, command }) => {
    const env = loadEnv(mode, '.', '');
    const apiTarget = env.VITE_API_TARGET || 'http://127.0.0.1:8080';
    return {
        // 生产构建挂载在 /ui/ 下（服务端静态托管，/admin/* 留给 JSON 管理 API，
        // 避免同一前缀下一半页面一半接口）；开发模式留在根路径，
        // 这样 /admin、/v1 的代理规则不会跟应用自身的资源请求打架。
        base: command === 'build' ? '/ui/' : '/',
        plugins: [react()],
        server: {
            proxy: {
                '/admin': { target: apiTarget, changeOrigin: true },
                '/v1': { target: apiTarget, changeOrigin: true },
            },
        },
        build: {
            outDir: 'dist',
            sourcemap: true,
        },
        test: {
            environment: 'jsdom',
            globals: false,
            setupFiles: ['./src/test/setup.ts'],
        },
    };
});
