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
