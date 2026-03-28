import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { healthRoute } from "./routes/health.ts"
import { wordsRoute } from "./routes/words.ts"
import { languagesRoute } from "./routes/languages.ts"
import { userRoute } from "./routes/user.ts"
import { progressRoute } from "./routes/progress.ts"
import { testRoute } from "./routes/test.ts"
import { adminLanguagesRoute } from "./routes/admin/languages.ts"
import { adminJobsRoute } from "./routes/admin/jobs.ts"
import { adminCheckRoute } from "./routes/admin/check.ts"

const app = new Hono().basePath("/api")

app.use("*", logger())
app.use(
	"*",
	cors({
		origin: ["http://localhost:3000"],
		credentials: true,
	}),
)

// Public routes
app.route("/health", healthRoute)
app.route("/languages", languagesRoute)

// Authenticated routes
app.route("/words", wordsRoute)
app.route("/user", userRoute)
app.route("/progress", progressRoute)
app.route("/test", testRoute)

// Admin routes
app.route("/admin/check", adminCheckRoute)
app.route("/admin/languages", adminLanguagesRoute)
app.route("/admin/jobs", adminJobsRoute)

export type AppType = typeof app
export { app }
