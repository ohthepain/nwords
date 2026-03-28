import { Hono } from "hono"
import { authMiddleware } from "../../middleware/auth.ts"
import { adminMiddleware } from "../../middleware/admin.ts"

export const adminCheckRoute = new Hono()
	.use("*", authMiddleware, adminMiddleware)
	.get("/", (c) => {
		return c.json({ admin: true })
	})
