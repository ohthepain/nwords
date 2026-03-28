import { prisma } from "@nwords/db"
import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000"

const googleClientId = process.env.GOOGLE_CLIENT_ID
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET

export const auth = betterAuth({
	baseURL,
	trustedOrigins: [baseURL],
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
	},
	session: {
		expiresIn: 60 * 60 * 24 * 7, // 7 days
		updateAge: 60 * 60 * 24, // 1 day
	},
	...(googleClientId &&
		googleClientSecret && {
			socialProviders: {
				google: {
					clientId: googleClientId,
					clientSecret: googleClientSecret,
					prompt: "select_account",
				},
			},
		}),
})

export type Auth = typeof auth
