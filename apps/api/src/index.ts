import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { healthRoute } from "./routes/health.ts"
import { wordsRoute } from "./routes/words.ts"

const app = new Hono().basePath("/api")

app.use("*", logger())
app.use(
	"*",
	cors({
		origin: ["http://localhost:3000"],
		credentials: true,
	}),
)

app.route("/health", healthRoute)
app.route("/words", wordsRoute)

export type AppType = typeof app
export { app }
