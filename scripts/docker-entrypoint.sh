#!/bin/sh
set -e
# RDS is private; GitHub Actions cannot reach it. Apply migrations before serving.
echo "[entrypoint] prisma migrate deploy…"
cd /app/packages/db
npx prisma migrate deploy
echo "[entrypoint] seeding database…"
npx tsx prisma/seed.ts
echo "[entrypoint] starting app"
cd /app/apps/web
exec "$@"
