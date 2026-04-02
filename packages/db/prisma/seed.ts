import path from "node:path"
import { fileURLToPath } from "node:url"
import { LANGUAGES } from "@nwords/shared"
import { PrismaPg } from "@prisma/adapter-pg"
import { hashPassword } from "better-auth/crypto"
import { config } from "dotenv"
import pg from "pg"
import { PrismaClient } from "../src/generated/prisma/client.js"

const DEFAULT_ADMIN_EMAIL = "cremoni@gmail.com"

const seedDir = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.join(seedDir, "../.env") })
config({ path: path.join(seedDir, "../../.env") })

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
	throw new Error("DATABASE_URL is not set")
}

const pool = new pg.Pool({ connectionString })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

async function ensureDefaultAdmin() {
	const email = DEFAULT_ADMIN_EMAIL.toLowerCase()
	const seedPassword = process.env.SEED_ADMIN_PASSWORD?.trim() || "dev-admin-password-change-me"

	if (!process.env.SEED_ADMIN_PASSWORD?.trim()) {
		console.warn(
			"[seed] SEED_ADMIN_PASSWORD is unset; using a default dev password. Set SEED_ADMIN_PASSWORD in .env for non-local use.",
		)
	}

	const existing = await prisma.user.findUnique({
		where: { email },
		include: { accounts: true },
	})

	const passwordHash = await hashPassword(seedPassword)

	if (!existing) {
		const user = await prisma.user.create({
			data: {
				name: "Admin",
				email,
				role: "ADMIN",
				emailVerified: true,
			},
		})
		await prisma.account.create({
			data: {
				userId: user.id,
				providerId: "credential",
				accountId: user.id,
				password: passwordHash,
			},
		})
		console.log(`Created default admin: ${email}`)
		return
	}

	await prisma.user.update({
		where: { id: existing.id },
		data: { role: "ADMIN" },
	})

	const hasCredential = existing.accounts.some((a) => a.providerId === "credential")
	if (!hasCredential) {
		await prisma.account.create({
			data: {
				userId: existing.id,
				providerId: "credential",
				accountId: existing.id,
				password: passwordHash,
			},
		})
		console.log(`Added email/password login for existing user: ${email}`)
	} else {
		console.log(`Default admin already exists (password unchanged): ${email}`)
	}
}

async function main() {
	console.log("Seeding languages...")

	for (const lang of LANGUAGES) {
		await prisma.language.upsert({
			where: { code: lang.code },
			update: { name: lang.name, code3: lang.code3 },
			create: {
				code: lang.code,
				code3: lang.code3,
				name: lang.name,
				enabled: false,
			},
		})
	}

	console.log(`Seeded ${LANGUAGES.length} languages`)

	await ensureDefaultAdmin()
}

main()
	.catch((e) => {
		console.error(e)
		process.exit(1)
	})
	.finally(() => prisma.$disconnect())
