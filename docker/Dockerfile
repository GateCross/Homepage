# syntax=docker/dockerfile:1.7

# ---- 单镜像：nginx 托管前端产物，同容器反代 Go 服务 ----
# 阶段一：Node 构建前端产物
FROM node:22-alpine AS web
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
# apps/web/tsconfig.json 经 extends 链解析到根 tsconfig.base.json，tsc 必须能读到
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .nvmrc tsconfig.base.json ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter=@homepage/web...
COPY apps/web apps/web
RUN pnpm --filter @homepage/web build

# 阶段二：Go 静态编译
FROM golang:1.27-alpine AS api
# 版本号由 CI 以 build-arg 注入，本地构建缺省为 0.0.0
ARG VERSION=0.0.0

WORKDIR /src/apps/api

COPY apps/api/go.mod apps/api/go.sum ./
RUN go mod download

COPY apps/api ./

# go-build 缓存挂载：同一 builder 上的重复构建（本地反复 compose build）可复用编译缓存
RUN --mount=type=cache,target=/root/.cache/go-build \
  CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X github.com/gatecross/homepage/api/internal/httpapi.Version=${VERSION}" -o /out/homepage-api ./cmd/homepage-api

# 阶段三：运行时——nginx 前台对外，Go 仅监听容器内回环
FROM nginx:1.30-alpine

# ca 证书供 Go 出站 HTTPS（天气、图标抓取、版本检查）使用；su-exec 用于把 Go 降权到 homepage 用户
RUN apk add --no-cache ca-certificates su-exec \
  && addgroup -S homepage \
  && adduser -S homepage -G homepage

COPY --from=api /out/homepage-api /app/homepage-api
COPY --from=web /app/apps/web/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
  && mkdir -p /app/config/images /app/config/icons \
  && chown -R homepage:homepage /app

ENV HOST=127.0.0.1 PORT=8080 CONFIG_DIR=/app/config

# 健康检查走 nginx 全链路：静态托管 + 反代到 Go
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "--spider", "http://127.0.0.1:80/api/version"]

EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
