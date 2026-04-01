/**
 * Ingestion script: seed POS mismatch messages for all enabled languages.
 *
 * For each enabled language, inserts 12 rows (4 POS x 3 mismatch targets)
 * into the `pos_mismatch_message` table.  Uses pre-authored static messages
 * from `@nwords/shared`, falling back to English for languages without
 * dedicated translations.
 *
 * Usage:
 *   pnpm --filter @nwords/api exec tsx src/scripts/seed-pos-mismatch-messages.ts
 *
 * Safe to run multiple times — uses upsert to avoid duplicates.
 */

import path from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"

const dir = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.join(dir, "../../../../.env") })
config({ path: path.join(dir, "../../../../packages/db/.env") })

async function run() {
	const { prisma } = await import("@nwords/db")
	const { seedPosMismatchMessages } = await import("../lib/seed-pos-mismatch-messages")

	try {
		const result = await seedPosMismatchMessages()

		if (result.languageCount === 0) {
			console.log("No enabled languages found. Nothing to seed.")
			return
		}

		console.log(`Seeding POS mismatch messages for ${result.languageCount} enabled language(s)…\n`)

		for (const lang of result.languages) {
			const fallbackNote = lang.usedEnglishFallback ? " (English fallback)" : ""
			console.log(`  ${lang.name} (${lang.code}): ${lang.upserted} messages${fallbackNote}`)
		}

		console.log(
			`\nDone. ${result.totalUpserted} messages upserted across ${result.languageCount} language(s).`,
		)
	} finally {
		await prisma.$disconnect()
	}
}

run().catch((err) => {
	console.error("Failed to seed POS mismatch messages:", err)
	process.exit(1)
})
