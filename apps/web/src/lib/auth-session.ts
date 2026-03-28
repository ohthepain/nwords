import { auth } from "@nwords/auth/server"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
	const request = getRequest()
	if (!request) return null
	const session = await auth.api.getSession({ headers: request.headers })
	return session
})
