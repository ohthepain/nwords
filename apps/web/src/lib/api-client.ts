import { hc } from "hono/client"
import type { AppType } from "@nwords/api"

/**
 * Type-safe Hono RPC client.
 * In the browser, calls go through the TanStack Start wildcard proxy at /api/*.
 * Base URL is empty so requests are relative (same origin).
 */
export const api = hc<AppType>("/")
