# syntax=docker/dockerfile:1
# Single image: TanStack Start server + in-process API (linux/arm64 for ECS Graviton).
FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY pnpm-lock.yaml package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build

RUN pnpm install --frozen-lockfile
RUN pnpm db:generate
RUN pnpm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app /app

WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node", "server-production.mjs"]
