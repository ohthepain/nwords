# Ingestion pipeline: UI, reliability, and workers

## Phase 1 (implemented)

- **Languages admin** (`/admin/languages`): each **enabled** language shows a nested strip of recent ingestion jobs (type, status, progress, Cancel / Retry) using the same APIs as `/admin/jobs`. Disabled languages do not show job rows.
- **Polling** on the languages page when any shown job is `PENDING` or `RUNNING`.
- **Stale `RUNNING` sweep**: worker processes periodically mark ingestion rows that have been `RUNNING` longer than a threshold as `FAILED`, so spot/preempted Fargate tasks do not leave the admin UI stuck forever. Config: `STALE_INGESTION_JOB_MINUTES`, `STALE_INGESTION_SWEEP_INTERVAL_MS`.

## Data hygiene (implemented)

- **Retry supersedes old row**: On successful `POST /api/admin/jobs/:id/retry`, after `boss.send` completes, the failed/cancelled `IngestionJob` row that was retried is **deleted**. If enqueue fails, the old row remains.
- **Stable list ordering**: Job lists use `orderBy: [{ createdAt: "desc" }, { id: "desc" }]` (API + web loaders). Per-language job strips on Languages admin sort the same way so refresh does not reorder tied timestamps.
- **Full language re-import**: When enqueueing the full Kaikki → frequency → Tatoeba pipeline (`enqueueLanguageIngestionPipeline`), terminal rows for that language (**COMPLETED**, **FAILED**, **CANCELLED**) are **deleted** first so the admin list stays small. **PENDING** / **RUNNING** rows are kept so an in-flight job is not removed by mistake.
- **Retention policy**: No scheduled TTL for `COMPLETED` jobs by default; history is trimmed by **per-job retry** (supersedes failed row) and **full re-import** (clears finished rows for that language). Keeping past completed rows otherwise is acceptable unless storage becomes an issue.

## Job observability (planned)

**Problem:** Operators often cannot see *why* a job failed beyond a single `metadata.error` string (when present). Progress is numeric only (`processedItems` / `totalItems`), not human-readable steps.

**Goals:**

1. **Meaningful progress lines** — e.g. “Downloading Kaikki noun stream…”, “Flushing batch 12…”, “Frequency: applied 50k ranks”.
2. **Structured failure visibility** — stack or message on stderr stream; keep final `metadata.error` (or equivalent) for summaries.
3. **Two logical streams** — akin to **stdout** (progress + info) and **stderr** (warnings + fatal context). Workers are in-process Node, not subprocesses; we **persist** two append-only buffers rather than OS pipes.
4. **Admin UI** — Per job: open a **“Output”** panel (modal, drawer, or slide-over) with tabs **Output** / **Errors**, monospace font, scrollable; show latest content first or tail-style with autoscroll to bottom (user preference in UI).
5. **Realtime** — Prefer **incremental updates** while `RUNNING`:
   - **Short-term:** Continue polling `GET /api/admin/jobs/:id` (or extend existing list polling) every 1–2s and merge `metadata` into the log viewer (simplest, works with existing auth).
   - **Upgrade:** **SSE** (`GET /api/admin/jobs/:id/stream`) that emits JSON patches or full log tail every N ms until terminal status; admin uses `EventSource` (cookie session may require same-origin + correct headers; fallback to fetch streaming or polling if needed).
   - **Avoid** requiring WebSockets unless you already run a WS layer.

**Persistence design (recommended first iteration):**

- Store under **`IngestionJob.metadata`** to avoid a migration initially, e.g.  
  `metadata.jobLogs = { out: string[], err: string[], maxLines: number }`  
  or ring buffer of `{ t: ISO8601, stream: "out"|"err", line: string }[]` with a **hard cap** (lines or total chars) so JSON does not balloon.
- Add a small helper (e.g. `appendJobLog(jobId, stream, line)`) that **read-merge-truncate-write** in a transaction or uses `update` with Prisma JSON carefully to reduce race data loss (acceptable to lose occasional interleaved lines under high concurrency; ingestion is single-worker per job id in practice).
- On fatal failure, workers already set `status: FAILED` and `metadata.error` — also **append** the same message to `err` stream (and optionally `error.stack` for dev).

**Worker touchpoints:**

- [Kaikki](apps/api/src/workers/kaikki.ts), [frequency](apps/api/src/workers/frequency.ts), [tatoeba](apps/api/src/workers/tatoeba.ts): at download start/end, batch flushes, completion, and `catch` blocks — call logger with meaningful messages.
- Reuse or extend [job-progress.ts](apps/api/src/lib/job-progress.ts) so log appends can share the same metadata merge path as `ingestSpeed` (batching log writes every N lines or every M seconds to limit DB writes).

**API:**

- Existing `GET /api/admin/jobs/:id` can return logs in `metadata`; if payloads get large, add `GET /api/admin/jobs/:id/logs` that returns only `jobLogs` + status for the output viewer.

**Security:** Admin-only routes only; logs may contain filenames or URLs — no secrets in log lines (strip or redact tokens if any).

## Phase 2 (future)

- **Dedicated worker tasks** (e.g. ECS Fargate/Fargate Spot): API with `DISABLE_INGEST_WORKERS=true`; separate task image/command runs the same API entry with workers enabled and shared `DATABASE_URL`. Graceful `SIGTERM` already stops pg-boss; sweep covers hard kills. **Observability:** container stdout/stderr in CloudWatch remain useful for platform debugging; **persisted job logs** are what the product UI shows.

## Phase 3 (future)

- **Durable pipeline run**: `PipelineRun` + `PipelineStep` (or equivalent) in Prisma; thin **orchestrator** pg-boss job advances steps, skips completed steps on restart, and supports selective re-run of one stage. Replaces implicit chaining inside Kaikki/frequency workers. **Observability:** aggregate step logs under the run for a single “pipeline output” view.

## Phase 4 (future)

- Align pg-boss job lifecycle with Prisma status (optional), or document that operators should use **Retry** after a stale sweep for true re-execution.
