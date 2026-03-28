import { app } from "@nwords/api"
import { createFileRoute } from "@tanstack/react-router"

function proxyToHono({ request }: { request: Request }) {
	return app.fetch(request)
}

export const Route = createFileRoute("/api/$")({
	server: {
		handlers: {
			GET: proxyToHono,
			POST: proxyToHono,
			PUT: proxyToHono,
			PATCH: proxyToHono,
			DELETE: proxyToHono,
		},
	},
})
