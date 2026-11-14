# syntax=docker/dockerfile:1.7

# ---- api：Go 静态二进制；前端产物不再嵌入，由 web 容器经 nginx 反代 ----
FROM golang:1.27-alpine AS build

# 版本号由 CI 以 build-arg 注入，本地构建缺省为 0.0.0
ARG VERSION=0.0.0

WORKDIR /src/apps/api

COPY apps/api/go.mod apps/api/go.sum ./
RUN go mod download

COPY apps/api ./

# go-build 缓存挂载：同一 builder 上的重复构建（本地反复 compose build）可复用编译缓存
RUN --mount=type=cache,target=/root/.cache/go-build \
  CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X github.com/gatecross/homepage/api/internal/httpapi.Version=${VERSION}" -o /out/homepage-api ./cmd/homepage-api

FROM alpine:3.22

# ca 证书供出站 HTTPS（天气、图标抓取、版本检查）使用
RUN apk add --no-cache ca-certificates \
  && addgroup -S homepage \
  && adduser -S homepage -G homepage

WORKDIR /app

ENV HOST=0.0.0.0 PORT=8080 CONFIG_DIR=/app/config

COPY --from=build /out/homepage-api /app/homepage-api

RUN mkdir -p /app/config/images /app/config/icons \
  && chown -R homepage:homepage /app

USER homepage

EXPOSE 8080

# 健康检查复用二进制自带的 -healthcheck 模式，运行镜像无需另装探针工具
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/app/homepage-api", "-healthcheck"]

ENTRYPOINT ["/app/homepage-api"]
