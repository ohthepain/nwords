import { prisma } from "@nwords/db"
import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { isSesConfigured, renderAuthEmailTemplate, sendAuthEmail } from "./auth-email"

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000"

const googleClientId = process.env.GOOGLE_CLIENT_ID
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET

const sesConfigured = isSesConfigured()

/**
 * Better Auth compares `redirectTo` to trusted origins by exact origin string.
 * Browsers often use 127.0.0.1 vs localhost; add both so password reset works locally.
 */
function expandLocalhostOriginAliases(origins: string[]): string[] {
	const out = new Set(origins)
	for (const o of origins) {
		try {
			const u = new URL(o)
			if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") continue
			const altHost = u.hostname === "localhost" ? "127.0.0.1" : "localhost"
			const portPart = u.port ? `:${u.port}` : ""
			out.add(`${u.protocol}//${altHost}${portPart}`)
		} catch {
			// ignore non-URL entries
		}
	}
	return [...out]
}

function buildTrustedOrigins(): string[] {
	const extra =
		process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",")
			.map((s) => s.trim())
			.filter(Boolean) ?? []
	return expandLocalhostOriginAliases([...new Set([baseURL, ...extra])])
}

export const auth = betterAuth({
	baseURL,
	basePath: "/api/auth",
	trustedOrigins: buildTrustedOrigins(),
	// Prisma schema uses @db.Uuid for ids; better-auth defaults to non-UUID strings otherwise.
	advanced: {
		database: {
			generateId: () => crypto.randomUUID(),
		},
	},
	database: prismaAdapter(prisma, {
		provider: "postgresql",
	}),
	emailAndPassword: {
		enabled: true,
		requireEmailVerification: sesConfigured,
		sendResetPassword: async ({ user, url }) => {
			const { html, text } = renderAuthEmailTemplate({
				heading: "Reset your password",
				intro: "We received a request to reset the password for your nwords account. Use the button below to choose a new password. This link expires soon.",
				actionLabel: "Reset password",
				actionUrl: url,
				outro: "If you did not request this, you can ignore this email.",
			})
			await sendAuthEmail({
				to: user.email,
				subject: "Reset your nwords password",
				html,
				text,
			})
		},
	},
	...(sesConfigured
		? {
				emailVerification: {
					sendVerificationEmail: async ({ user, url }) => {
						const { html, text } = renderAuthEmailTemplate({
							heading: "Verify your email",
							intro: "Thanks for signing up for nwords. Confirm your email address to finish setting up your account.",
							actionLabel: "Verify email",
							actionUrl: url,
							outro: "If you did not create an account, you can ignore this email.",
						})
						await sendAuthEmail({
							to: user.email,
							subject: "Verify your nwords email",
							html,
							text,
						})
					},
					autoSignInAfterVerification: true,
				},
			}
		: {}),
	session: {
		expiresIn: 60 * 60 * 24 * 7, // 7 days
		updateAge: 60 * 60 * 24, // 1 day
	},
	...(googleClientId && googleClientSecret
		? {
				socialProviders: {
					google: {
						clientId: googleClientId,
						clientSecret: googleClientSecret,
						prompt: "select_account",
					},
				},
			}
		: {}),
})

export type Auth = typeof auth
