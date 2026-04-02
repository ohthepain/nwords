import { zValidator } from "@hono/zod-validator"
import { prisma } from "@nwords/db"
import { Hono } from "hono"
import { z } from "zod"
import { APP_SETTINGS_ROW_ID, getAppSettings } from "../../lib/app-settings"
import { seedPosMismatchMessages } from "../../lib/seed-pos-mismatch-messages"
import { adminMiddleware } from "../../middleware/admin"
import { authMiddleware } from "../../middleware/auth"

const patchSchema = z.object({
	showHints: z.boolean().optional(),
	aiProvider: z.string().optional(),
	aiModel: z.string().optional(),
	aiApiKey: z.string().optional(),
})

export const adminSettingsRoute = new Hono()
	.use("*", authMiddleware, adminMiddleware)
	.get("/", async (c) => {
		const s = await getAppSettings()
		return c.json({
			id: s.id,
			showHints: s.showHints,
			aiProvider: s.aiProvider,
			aiModel: s.aiModel,
			aiApiKeySet: !!s.aiApiKey,
			updatedAt: s.updatedAt.toISOString(),
		})
	})
	.patch("/", zValidator("json", patchSchema), async (c) => {
		const body = c.req.valid("json")
		const data: Record<string, unknown> = {}
		if (body.showHints !== undefined) data.showHints = body.showHints
		if (body.aiProvider !== undefined) data.aiProvider = body.aiProvider || null
		if (body.aiModel !== undefined) data.aiModel = body.aiModel || null
		if (body.aiApiKey !== undefined) data.aiApiKey = body.aiApiKey || null
		const updated = await prisma.appSettings.upsert({
			where: { id: APP_SETTINGS_ROW_ID },
			create: { id: APP_SETTINGS_ROW_ID, showHints: false, ...data },
			update: data,
		})
		return c.json({
			id: updated.id,
			showHints: updated.showHints,
			aiProvider: updated.aiProvider,
			aiModel: updated.aiModel,
			aiApiKeySet: !!updated.aiApiKey,
			updatedAt: updated.updatedAt.toISOString(),
		})
	})
	.post("/pos-mismatch-messages", async (c) => {
		const result = await seedPosMismatchMessages()
		return c.json(result)
	})
