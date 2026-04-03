# syntax=docker/dockerfile:1
# Single image: TanStack Start server + in-process API (linux/arm64 for ECS Graviton).
FROM node:22-bookworm-slim AS builder
ARG GOOGLE_AUTH_ENABLED=false
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
RUN GOOGLE_AUTH_ENABLED="$GOOGLE_AUTH_ENABLED" pnpm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app

# Node uses its own CA store for TLS (not Debian's). RDS certs chain to Amazon PKI roots
# that are not in Node's default bundle; without this, pg/Prisma fail with
# "self-signed certificate in certificate chain" against AWS RDS.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates curl \
	&& curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
		-o /etc/ssl/certs/rds-global-bundle.pem \
	&& rm -rf /var/lib/apt/lists/*

ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app /app

COPY scripts/docker-entrypoint.sh /app/scripts/docker-entrypoint.sh
RUN chmod +x /app/scripts/docker-entrypoint.sh

WORKDIR /app/apps/web
EXPOSE 3000
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "server-production.mjs"]
