# nwords.live

A precision vocabulary testing tool. Measure, track, and expand your vocabulary in any language.

## Tech Stack

- **Frontend**: TanStack Start, shadcn/ui, Tailwind CSS, Zustand
- **Backend**: Hono, pg-boss
- **Database**: PostgreSQL, Prisma
- **Auth**: better-auth
- **Testing**: Vitest, Playwright
- **Tooling**: Biome, Turborepo, pnpm
- **Infrastructure**: AWS (Terraform), S3, CloudFront

## Development

Put your environment variables in a **`.env` file at the repository root** (not only under `apps/web/`). TanStack Start’s dev server loads that file for SSR, and Prisma needs `DATABASE_URL` there when `/api` routes run in Vite.

```bash
# Install dependencies
pnpm install

# Start PostgreSQL
docker compose up -d

# Generate Prisma client and push schema
pnpm db:generate
pnpm db:push

# Start dev servers (web on http://localhost:3000, optional standalone API on PORT or 3001)
pnpm dev
```

Copy `.env.example` to `.env` and adjust values before the first run.

### Google sign-in (optional)

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create an OAuth 2.0 Client ID (Web application).
2. Under **Authorized redirect URIs**, add `http://localhost:3000/api/auth/callback/google` (and your production URL + `/api/auth/callback/google` when you deploy). It must match `BETTER_AUTH_URL`.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_AUTH_ENABLED=true` in `.env` at the repo root, then restart `pnpm dev`.

## Project Structure

```
apps/
  web/    # TanStack Start frontend
  api/    # Hono API server
packages/
  db/     # Prisma schema + client
  shared/ # Shared types + constants
  auth/   # better-auth config
infra/    # Terraform
data/     # Data processing scripts
```
