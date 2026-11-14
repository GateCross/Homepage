# syntax=docker/dockerfile:1.7
# ---- web：Node 构建前端产物；nginx 托管静态并反代 API ----
FROM node:22-alpine AS web
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
# apps/web/tsconfig.json 经 extends 链解析到根 tsconfig.base.json，tsc 必须能读到
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .nvmrc tsconfig.base.json ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter=@homepage/web...
COPY apps/web apps/web
RUN pnpm --filter @homepage/web build
FROM nginx:1.27-alpine
COPY --from=web /app/apps/web/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
