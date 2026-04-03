#!/bin/sh
set -e
# RDS is private; GitHub Actions cannot reach it. Apply migrations before serving.
cd /app/packages/db
npx prisma migrate deploy
cd /app/apps/web
exec "$@"
