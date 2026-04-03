/**
 * TanStack Start's Vite build emits a Web Fetch handler only (no HTTP listen).
 * Running `node dist/server/server.js` loads the module and exits 0 — ECS sees
 * "Essential container exited" with no CloudWatch logs. This file binds the
 * handler to Node's HTTP server (0.0.0.0 for Fargate/ALB health checks).
 */
import { serve } from "@hono/node-server"
import server from "./dist/server/server.js"

const port = Number(process.env.PORT) || 3000
const hostname = process.env.HOST ?? "0.0.0.0"

serve(
	{
		fetch: (req) => server.fetch(req),
		port,
		hostname,
	},
	(info) => {
		console.log(`Listening on http://${hostname}:${info.port}`)
	},
)
