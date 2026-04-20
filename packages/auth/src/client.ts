import { createAuthClient } from "better-auth/client"
import { anonymousClient } from "better-auth/client/plugins"

export function createNwordsAuthClient(baseURL?: string) {
	return createAuthClient({
		baseURL: baseURL ?? "",
		plugins: [anonymousClient()],
	})
}

export type AuthClient = ReturnType<typeof createNwordsAuthClient>
