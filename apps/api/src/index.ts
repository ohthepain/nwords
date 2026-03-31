import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { adminCheckRoute } from "./routes/admin/check"
import { adminClozeReportsRoute } from "./routes/admin/cloze-reports"
import { adminJobsRoute } from "./routes/admin/jobs"
import { adminLanguagesRoute } from "./routes/admin/languages"
import { healthRoute } from "./routes/health"
import { languagesRoute } from "./routes/languages"
import { progressRoute } from "./routes/progress"
import { testRoute } from "./routes/test"
import { userRoute } from "./routes/user"
import { wordsRoute } from "./routes/words"

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
app.route("/admin/cloze-reports", adminClozeReportsRoute)

export type AppType = typeof app
export { app }
