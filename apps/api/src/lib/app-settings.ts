import { prisma } from "@nwords/db"

export const APP_SETTINGS_ROW_ID = "default"

/**
 * Ensures the singleton settings row exists and returns it.
 */
export async function getAppSettings() {
	return prisma.appSettings.upsert({
		where: { id: APP_SETTINGS_ROW_ID },
		create: { id: APP_SETTINGS_ROW_ID, showHints: false },
		update: {},
	})
}
