import path from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"

const dir = path.dirname(fileURLToPath(import.meta.url))
// Load before importing the app (Prisma reads DATABASE_URL at module init).
config({ path: path.join(dir, "../../../.env") })
config({ path: path.join(dir, "../../../packages/db/.env") })

const { serve } = await import("@hono/node-server")
const { app } = await import("./index.js")
const { getBoss } = await import("./lib/boss.js")

// Pg-boss + ingestion workers start inside getBoss()
await getBoss()

const port = Number(process.env.PORT) || 3001

const server = serve({ fetch: app.fetch, port }, (info) => {
	console.log(`API listening on http://localhost:${info.port}`)
})

server.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EADDRINUSE") {
		console.error(
			`Port ${port} is already in use. Set PORT in .env to a free port, or stop the process using it (e.g. lsof -i :${port}).`,
		)
	} else {
		console.error(err)
	}
	process.exit(1)
})

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		console.log(`\n${signal} received, shutting down...`)
		const { stopBoss } = await import("./lib/boss.js")
		await stopBoss()
		server.close()
		process.exit(0)
	})
}
