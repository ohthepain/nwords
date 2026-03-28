import { PrismaPg } from "@prisma/adapter-pg"
import pg from "pg"
import { PrismaClient } from "./generated/prisma/client.js"

const globalForPrisma = globalThis as unknown as {
	prisma: PrismaClient | undefined
}

function createPrismaClient(): PrismaClient {
	const connectionString = process.env.DATABASE_URL
	if (!connectionString) {
		throw new Error("DATABASE_URL is not set")
	}
	const pool = new pg.Pool({ connectionString })
	const adapter = new PrismaPg(pool)
	return new PrismaClient({ adapter })
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") {
	globalForPrisma.prisma = prisma
}

export { PrismaClient }
export * from "./generated/prisma/client.js"
