import { Hono } from "hono"
import { adminMiddleware } from "../../middleware/admin.ts"
import { authMiddleware } from "../../middleware/auth.ts"

export const adminCheckRoute = new Hono()
	.use("*", authMiddleware, adminMiddleware)
	.get("/", (c) => {
		return c.json({ admin: true })
	})
