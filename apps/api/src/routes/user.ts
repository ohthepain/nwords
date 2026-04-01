import { zValidator } from "@hono/zod-validator"
import { prisma } from "@nwords/db"
import { Hono } from "hono"
import { z } from "zod"
import { authMiddleware } from "../middleware/auth"

export const userRoute = new Hono()
	.use("*", authMiddleware)

	// Get current user profile
	.get("/me", async (c) => {
		const user = c.get("user")

		const dbUser = await prisma.user.findUnique({
			where: { id: user.id },
			include: {
				nativeLanguage: { select: { id: true, code: true, name: true } },
				targetLanguage: { select: { id: true, code: true, name: true } },
			},
		})

		if (!dbUser) {
			return c.json({ error: "User not found" }, 404)
		}

		return c.json({
			id: dbUser.id,
			name: dbUser.name,
			email: dbUser.email,
			role: dbUser.role,
			nativeLanguage: dbUser.nativeLanguage,
			targetLanguage: dbUser.targetLanguage,
		})
	})

	// Update native language only (target must already be set)
	.patch(
		"/me/native-language",
		zValidator(
			"json",
			z.object({
				nativeLanguageId: z.string().uuid(),
			}),
		),
		async (c) => {
			const user = c.get("user")
			const { nativeLanguageId } = c.req.valid("json")

			const dbUser = await prisma.user.findUnique({
				where: { id: user.id },
				select: { targetLanguageId: true },
			})

			if (!dbUser?.targetLanguageId) {
				return c.json(
					{ error: "Set a target language under Settings before changing your language." },
					400,
				)
			}

			if (nativeLanguageId === dbUser.targetLanguageId) {
				return c.json({ error: "Your language and the language you study must be different." }, 400)
			}

			const native = await prisma.language.findUnique({ where: { id: nativeLanguageId } })
			if (!native) {
				return c.json({ error: "Language not found" }, 404)
			}

			const updated = await prisma.user.update({
				where: { id: user.id },
				data: { nativeLanguageId },
				include: {
					nativeLanguage: { select: { id: true, code: true, name: true } },
				},
			})

			return c.json({
				nativeLanguage: updated.nativeLanguage,
			})
		},
	)

	// Update language preferences
	.patch(
		"/me/languages",
		zValidator(
			"json",
			z.object({
				nativeLanguageId: z.string().uuid(),
				targetLanguageId: z.string().uuid(),
			}),
		),
		async (c) => {
			const user = c.get("user")
			const { nativeLanguageId, targetLanguageId } = c.req.valid("json")

			if (nativeLanguageId === targetLanguageId) {
				return c.json({ error: "Native and target languages must be different" }, 400)
			}

			// Verify target language is enabled
			const targetLang = await prisma.language.findUnique({
				where: { id: targetLanguageId },
			})

			if (!targetLang?.enabled) {
				return c.json({ error: "Target language is not available" }, 400)
			}

			const updated = await prisma.user.update({
				where: { id: user.id },
				data: { nativeLanguageId, targetLanguageId },
				include: {
					nativeLanguage: { select: { id: true, code: true, name: true } },
					targetLanguage: { select: { id: true, code: true, name: true } },
				},
			})

			return c.json({
				nativeLanguage: updated.nativeLanguage,
				targetLanguage: updated.targetLanguage,
			})
		},
	)
