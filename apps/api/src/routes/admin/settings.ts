import { zValidator } from "@hono/zod-validator"
import { prisma } from "@nwords/db"
import { Hono } from "hono"
import { z } from "zod"
import { APP_SETTINGS_ROW_ID, getAppSettings } from "../../lib/app-settings"
import { adminMiddleware } from "../../middleware/admin"
import { authMiddleware } from "../../middleware/auth"

const patchSchema = z.object({
	showHints: z.boolean(),
})

export const adminSettingsRoute = new Hono()
	.use("*", authMiddleware, adminMiddleware)
	.get("/", async (c) => {
		const s = await getAppSettings()
		return c.json({
			id: s.id,
			showHints: s.showHints,
			updatedAt: s.updatedAt.toISOString(),
		})
	})
	.patch("/", zValidator("json", patchSchema), async (c) => {
		const { showHints } = c.req.valid("json")
		const updated = await prisma.appSettings.upsert({
			where: { id: APP_SETTINGS_ROW_ID },
			create: { id: APP_SETTINGS_ROW_ID, showHints },
			update: { showHints },
		})
		return c.json({
			id: updated.id,
			showHints: updated.showHints,
			updatedAt: updated.updatedAt.toISOString(),
		})
	})
