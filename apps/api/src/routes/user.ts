import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { prisma } from "@nwords/db"
import { authMiddleware } from "../middleware/auth.ts"

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
