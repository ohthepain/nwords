import { createAuthClient } from "better-auth/client"

export function createNwordsAuthClient(baseURL?: string) {
	return createAuthClient({
		baseURL: baseURL ?? "",
	})
}

export type AuthClient = ReturnType<typeof createNwordsAuthClient>
