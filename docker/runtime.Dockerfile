# syntax=docker/dockerfile:1.7

# ---- build：全量依赖 + monorepo dist ----
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .nvmrc ./
COPY tsconfig.base.json tsconfig.json tsconfig.eslint.json ./
COPY apps/web/package.json apps/web/tsconfig.json apps/web/
COPY packages/domain/package.json packages/domain/tsconfig.json packages/domain/
COPY packages/config/package.json packages/config/tsconfig.json packages/config/
COPY packages/adapters/package.json packages/adapters/tsconfig.json packages/adapters/
COPY packages/server/package.json packages/server/tsconfig.json packages/server/

RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY packages/domain packages/domain
COPY packages/config packages/config
COPY packages/adapters packages/adapters
COPY packages/server packages/server

RUN pnpm build \
  # 运行时只要 .js；类型声明 / sourcemap / tsbuildinfo 不进镜像
  && find packages -type f \( \
       -path '*/dist/*.map' \
       -o -path '*/dist/*.d.ts' \
       -o -path '*/dist/*.tsbuildinfo' \
       -o -name '.tsbuildinfo' \
     \) -delete

# ---- deps：仅 server 生产闭包（中间层，pnpm 不进入最终镜像）----
FROM node:22-alpine AS deps

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .nvmrc ./
COPY packages/domain/package.json packages/domain/
COPY packages/config/package.json packages/config/
COPY packages/adapters/package.json packages/adapters/
COPY packages/server/package.json packages/server/

RUN pnpm install --frozen-lockfile --prod --filter=@homepage/server... \
  && pnpm store prune \
  && rm -rf /root/.local/share/pnpm/store /tmp/*

# ---- runtime：node 基础镜像 + 生产依赖 + 构建产物（无 pnpm / 无前端依赖）----
FROM node:22-alpine AS runtime

LABEL org.opencontainers.image.title="homepage"
LABEL org.opencontainers.image.description="自托管仪表盘（React + Hono）"
LABEL org.opencontainers.image.source="https://github.com/GateCross/Homepage"

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    CONFIG_DIR=/app/config

RUN addgroup -S homepage && adduser -S homepage -G homepage

# 从 deps 拷贝已解析的 monorepo 安装树（含 .pnpm store 与 workspace 软链）
COPY --from=deps /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc /app/.nvmrc ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages

# 覆盖为构建产物（builder 已剔除 map/d.ts）；路径对齐 static.ts 默认 web dist
COPY --from=builder /app/packages/domain/dist packages/domain/dist
COPY --from=builder /app/packages/config/dist packages/config/dist
COPY --from=builder /app/packages/adapters/dist packages/adapters/dist
COPY --from=builder /app/packages/server/dist packages/server/dist
COPY --from=builder /app/apps/web/dist apps/web/dist

RUN mkdir -p /app/config/images /app/config/icons \
  && chown -R homepage:homepage /app

USER homepage

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "packages/server/dist/index.js"]
