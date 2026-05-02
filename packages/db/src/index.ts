import { PrismaPg } from "@prisma/adapter-pg"
import pg from "pg"
import { PrismaClient } from "./generated/prisma/client.js"

const globalForPrisma = globalThis as unknown as {
	prisma: PrismaClient | undefined
}

const REQUIRED_PRISMA_DELEGATES = ["generatedCloze", "generatedClozeTranslation"] as const

function hasRequiredPrismaDelegates(client: PrismaClient | undefined): boolean {
	if (!client) return false
	const clientObj = client as unknown as Record<string, unknown>
	return REQUIRED_PRISMA_DELEGATES.every((delegate) => typeof clientObj[delegate] === "object")
}

function createPrismaClient(): PrismaClient {
	const connectionString = process.env.DATABASE_URL
	if (!connectionString) {
		throw new Error("DATABASE_URL is not set")
	}
	const poolMax = Math.min(
		100,
		Math.max(5, Number.parseInt(process.env.DATABASE_POOL_MAX ?? "20", 10) || 20),
	)
	const pool = new pg.Pool({ connectionString, max: poolMax })
	const adapter = new PrismaPg(pool)
	const maxWait = Number.parseInt(process.env.PRISMA_TX_MAX_WAIT_MS ?? "20000", 10) || 20_000
	const timeout = Number.parseInt(process.env.PRISMA_TX_TIMEOUT_MS ?? "120000", 10) || 120_000
	return new PrismaClient({
		adapter,
		transactionOptions: {
			maxWait,
			timeout,
		},
	})
}

if (globalForPrisma.prisma && !hasRequiredPrismaDelegates(globalForPrisma.prisma)) {
	void globalForPrisma.prisma.$disconnect().catch(() => {
		// Best effort: the cached client is stale after a schema change, so discard it either way.
	})
	globalForPrisma.prisma = undefined
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") {
	globalForPrisma.prisma = prisma
}

export { PrismaClient }
export * from "./generated/prisma/client.js"
