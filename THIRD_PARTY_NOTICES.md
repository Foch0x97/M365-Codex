# 第三方依赖声明

本项目以 MIT 许可证发布，同时使用了下列第三方开源组件。各组件版权归其各自作者所有，使用需遵循其原始许可证。

## 运行时依赖

| 组件 | 许可证 | 用途 |
|---|---|---|
| [Fastify](https://github.com/fastify/fastify) | MIT | HTTP 服务框架 |
| [@fastify/multipart](https://github.com/fastify/fastify-multipart) | MIT | 文件上传（`/v1/files`、`/v1/uploads`）的 multipart/form-data 解析 |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) | Apache-2.0 | PDF 文本提取（legacy Node 构建） |
| [Pino](https://github.com/pinojs/pino) | MIT | 结构化日志 |
| [Zod](https://github.com/colinhacks/zod) | MIT | 配置与请求体校验 |

## 开发依赖

| 组件 | 许可证 | 用途 |
|---|---|---|
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 | 类型系统与编译 |
| [Vitest](https://github.com/vitest-dev/vitest) | MIT | 测试框架 |
| [ESLint](https://github.com/eslint/eslint) | MIT | 静态检查 |
| [typescript-eslint](https://github.com/typescript-eslint/typescript-eslint) | MIT | TypeScript 的 ESLint 支持 |
| [tsx](https://github.com/privatenumber/tsx) | MIT | 开发模式热重载 |
| [pino-pretty](https://github.com/pinojs/pino-pretty) | MIT | 开发模式日志美化 |

## 基础镜像与运行时

| 组件 | 许可证 | 说明 |
|---|---|---|
| [Node.js](https://github.com/nodejs/node) | MIT | 运行时；SQLite 能力来自内置的 `node:sqlite` 模块 |
| [SQLite](https://www.sqlite.org/copyright.html) | Public Domain | 通过 Node.js 内置模块使用 |
| [Alpine Linux](https://alpinelinux.org/) | 多种（详见发行版声明） | 容器基础镜像 |
| [tini](https://github.com/krallin/tini) | MIT | 容器内 init，负责信号转发与僵尸进程回收 |

## 声明

本项目与 Microsoft、OpenAI 无任何关联，未获得任何一方授权或背书。项目名称中的 "M365" 与 "Codex" 仅用于描述互操作对象，相关商标归其各自所有者。

完整的依赖树与精确版本可通过 `npm ls --all` 查看；各依赖的许可证原文位于安装后的 `node_modules/<包名>/LICENSE`。
