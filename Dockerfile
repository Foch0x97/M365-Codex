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
RUN npm run build

# 只保留生产依赖
RUN npm prune --omit=dev

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
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/apps/server/dist ./apps/server/dist

# node 镜像自带 uid/gid 1000 的 node 用户；数据目录需归它所有
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/server/dist/server.js"]
