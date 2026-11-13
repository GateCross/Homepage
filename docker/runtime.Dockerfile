# syntax=docker/dockerfile:1.7

# ---- web：只构建前端产物（Node 仅存在于这一层）----
FROM node:22-alpine AS web

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

# 只装前端所需清单，pnpm 按 lockfile 精确还原
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .nvmrc ./
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile --filter=@homepage/web...

COPY apps/web apps/web

RUN pnpm --filter @homepage/web build

# ---- api：Go 静态二进制；前端产物同步进嵌入目录后再编译 ----
FROM golang:1.27-alpine AS api

# 版本号由 CI 以 build-arg 注入，本地构建缺省为 0.0.0
ARG VERSION=0.0.0

WORKDIR /src/apps/api

# 先只拷依赖清单，让 go mod download 独立成层
COPY apps/api/go.mod apps/api/go.sum ./
RUN go mod download

COPY apps/api ./

# 前端产物走嵌入目录：syncdist 会清空目录后整体复制
COPY --from=web /app/apps/web/dist /src/apps/web/dist
RUN go generate ./internal/httpx \
  && CGO_ENABLED=0 go build \
       -trimpath \
       -ldflags="-s -w -X github.com/gatecross/homepage/api/internal/httpapi.Version=${VERSION}" \
       -o /out/homepage-api ./cmd/homepage-api

# ---- runtime：静态二进制 + ca 证书，无 Node / 无 pnpm / 无 shell 工具链 ----
FROM alpine:3.22 AS runtime

LABEL org.opencontainers.image.title="homepage"
LABEL org.opencontainers.image.description="自托管仪表盘（Go 后端 + React 前端）"
LABEL org.opencontainers.image.source="https://github.com/GateCross/Homepage"

# ca 证书供出站 HTTPS（天气、图标抓取、版本检查）使用
RUN apk add --no-cache ca-certificates \
  && addgroup -S homepage \
  && adduser -S homepage -G homepage

WORKDIR /app

ENV HOST=0.0.0.0 \
    PORT=3000 \
    CONFIG_DIR=/app/config

COPY --from=api /out/homepage-api /app/homepage-api

RUN mkdir -p /app/config/images /app/config/icons \
  && chown -R homepage:homepage /app

USER homepage

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/app/homepage-api", "-healthcheck"]

ENTRYPOINT ["/app/homepage-api"]
