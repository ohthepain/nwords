import { auth } from "@nwords/auth/server"
import { createFileRoute } from "@tanstack/react-router"

function handleAuth({ request }: { request: Request }) {
	return auth.handler(request)
}

export const Route = createFileRoute("/api/auth/$")({
	server: {
		handlers: {
			GET: handleAuth,
			POST: handleAuth,
		},
	},
})
