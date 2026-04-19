import { Hono } from "hono"
import { getAppSettings } from "../lib/app-settings"

/** Public read-only view of deploy-controlled flags (for practice UI, etc.). */
export const publicSettingsRoute = new Hono().get("/", async (c) => {
	const s = await getAppSettings()
	return c.json({ showHints: s.showHints, vocabGraphColors: s.vocabGraphColors ?? null })
})
