import { Hono } from "hono"
import { adminMiddleware } from "../../middleware/admin"
import { authMiddleware } from "../../middleware/auth"

export const adminCheckRoute = new Hono()
	.use("*", authMiddleware, adminMiddleware)
	.get("/", (c) => {
		return c.json({ admin: true })
	})
