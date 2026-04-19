import { zValidator } from "@hono/zod-validator"
import { prisma } from "@nwords/db"
import {
	applyVocabBuildSettingsPatch,
	assertVocabBuildStrategyPercents,
	mergeVocabBuildSettings,
} from "@nwords/shared"
import { Hono } from "hono"
import { z } from "zod"
import { APP_SETTINGS_ROW_ID, getAppSettings } from "../../lib/app-settings"
import { seedPosMismatchMessages } from "../../lib/seed-pos-mismatch-messages"
import { resolveVocabBuildSettings } from "../../lib/vocab-build-settings"
import { adminMiddleware } from "../../middleware/admin"
import { authMiddleware } from "../../middleware/auth"

const vocabBuildPatchSchema = z
	.object({
		frontierBandMax: z.number().int().min(5).max(200).optional(),
		workingSetSize: z.number().int().min(1).max(80).optional(),
		newWordsIntroChunkSize: z.number().int().min(1).max(40).optional(),
		confidenceCriterion: z.number().min(0.5).max(0.99).optional(),
		pReinforceWorkingSet: z.number().int().min(0).max(100).optional(),
		pIntroduce: z.number().int().min(0).max(100).optional(),
		pBandWalk: z.number().int().min(0).max(100).optional(),
	})
	.strict()

const hsvaSchema = z.object({
	h: z.number().min(0).max(360),
	s: z.number().min(0).max(100),
	v: z.number().min(0).max(100),
	a: z.number().min(0).max(1),
})

const vocabGraphColorsSchema = z.object({
	before: hsvaSchema,
	after: hsvaSchema,
	conquered: hsvaSchema,
	unconquered: hsvaSchema,
})

const patchSchema = z.object({
	showHints: z.boolean().optional(),
	aiProvider: z.string().optional(),
	aiModel: z.string().optional(),
	aiApiKey: z.string().optional(),
	vocabBuild: vocabBuildPatchSchema.optional(),
	vocabGraphColors: vocabGraphColorsSchema.optional(),
})

export const adminSettingsRoute = new Hono()
	.use("*", authMiddleware, adminMiddleware)
	.get("/", async (c) => {
		const s = await getAppSettings()
		const vocabBuild = await resolveVocabBuildSettings()
		return c.json({
			id: s.id,
			showHints: s.showHints,
			aiProvider: s.aiProvider,
			aiModel: s.aiModel,
			aiApiKeySet: !!s.aiApiKey,
			vocabBuild,
			vocabGraphColors: s.vocabGraphColors ?? null,
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
		if (body.vocabGraphColors !== undefined) data.vocabGraphColors = body.vocabGraphColors

		if (body.vocabBuild !== undefined) {
			const row = await prisma.appSettings.findUnique({ where: { id: APP_SETTINGS_ROW_ID } })
			const base = mergeVocabBuildSettings(row?.vocabBuildSettings ?? null)
			const next = applyVocabBuildSettingsPatch(base, body.vocabBuild)
			const pctErr = assertVocabBuildStrategyPercents(next)
			if (pctErr) {
				return c.json({ error: pctErr }, 400)
			}
			data.vocabBuildSettings = next
		}

		const updated = await prisma.appSettings.upsert({
			where: { id: APP_SETTINGS_ROW_ID },
			create: { id: APP_SETTINGS_ROW_ID, showHints: false, ...data },
			update: data,
		})
		const vocabBuild = mergeVocabBuildSettings(updated.vocabBuildSettings)
		return c.json({
			id: updated.id,
			showHints: updated.showHints,
			aiProvider: updated.aiProvider,
			aiModel: updated.aiModel,
			aiApiKeySet: !!updated.aiApiKey,
			vocabBuild,
			vocabGraphColors: updated.vocabGraphColors ?? null,
			updatedAt: updated.updatedAt.toISOString(),
		})
	})
	.post("/pos-mismatch-messages", async (c) => {
		const result = await seedPosMismatchMessages()
		return c.json(result)
	})
