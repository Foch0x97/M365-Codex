# syntax=docker/dockerfile:1
#
# M365-Codex 运行镜像。
# 单进程单容器：端口 8080，数据目录 /data，非 root 运行，支持 SIGTERM 优雅退出。
# 镜像内不包含开发依赖、账号文件、.env 或任何 Token。

# ---------- 构建阶段 ----------
FROM node:24-alpine AS builder
WORKDIR /app

# 先只复制清单，最大化利用层缓存
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
# 只构建服务端：根 build 脚本还会构建前端，而此时 apps/web 还没 COPY 进来
RUN npm run build:server

# 管理界面单独装依赖、单独构建。它不在根 workspace 里，用自己的 lockfile——
# 前端依赖树（React/Vite）和服务端毫无交集，混进同一个 lockfile 只会让
# 两边互相牵制。分开也让「只改前端」时的镜像层缓存不被服务端改动打断。
COPY apps/web/package.json apps/web/package-lock.json apps/web/
RUN npm ci --prefix apps/web
COPY apps/web apps/web
RUN npm run build --prefix apps/web

# 只保留生产依赖
RUN npm prune --omit=dev

# workspace 依赖不一定都能提升到根 node_modules：根目录被某个版本占位时
# （例如 eslint 依赖的 ajv@6），真正要用的版本会装在 apps/server/node_modules 下。
# 运行阶段必须把这一层也带上，否则容器起来就 ERR_MODULE_NOT_FOUND。
# 先建空目录，保证下面的 COPY 在依赖全部提升时也不会失败。
RUN mkdir -p apps/server/node_modules packages/shared/node_modules

# ---------- 运行阶段 ----------
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

# tini 负责转发信号并回收僵尸进程
RUN apk add --no-cache tini

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/server/node_modules ./apps/server/node_modules
# 管理界面只需要构建产物，不带前端的 node_modules
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# node 镜像自带 uid/gid 1000 的 node 用户；数据目录需归它所有
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/server/dist/server.js"]
