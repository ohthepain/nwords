/**
 * Headers for server-side `app.fetch()` to the Hono API.
 * Avoid copying the incoming request wholesale: a GET often has `Content-Length: 0`,
 * which breaks PATCH/POST bodies if forwarded unchanged.
 */
export function forwardedAdminApiHeaders(request: Request, init?: { jsonBody?: string }): Headers {
	const h = new Headers()
	const cookie = request.headers.get("cookie")
	if (cookie) {
		h.set("Cookie", cookie)
	}
	const authz = request.headers.get("authorization")
	if (authz) {
		h.set("Authorization", authz)
	}
	if (init?.jsonBody !== undefined) {
		h.set("Content-Type", "application/json")
	}
	return h
}
