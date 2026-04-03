import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
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

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// TanStack Start's production fetch handler renders HTML routes but does not
// automatically serve Vite's static client assets. Serve them explicitly so
// CSS/JS are available at their hashed `/assets/...` URLs.
const viteClientDir = path.join(__dirname, "dist", "client")
const viteAssetsDir = path.join(viteClientDir, "assets")

const mimeByExt = {
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".wasm": "application/wasm",
	".svg": "image/svg+xml; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".eot": "application/vnd.ms-fontobject",
}

function getMimeType(filePath) {
	const ext = path.extname(filePath).toLowerCase()
	return mimeByExt[ext] ?? "application/octet-stream"
}

async function tryServeStaticFile(req) {
	const url = new URL(req.url)
	const pathname = url.pathname

	// Best-effort decoding; if it fails, treat it as not found.
	let relPath
	try {
		relPath = decodeURIComponent(pathname.slice(1)) // strip leading "/"
	} catch {
		return null
	}
	if (!relPath) return null

	// Only serve files with a known static-asset extension.
	const ext = path.extname(relPath).toLowerCase()
	if (!mimeByExt[ext]) return null

	// Resolve against the client build output directory.
	const filePath = path.resolve(viteClientDir, relPath)
	// Prevent path traversal (e.g. `/../server.js`).
	if (!filePath.startsWith(viteClientDir + path.sep)) return null

	try {
		const data = await fs.readFile(filePath)
		const isHashed = pathname.startsWith("/assets/")
		return new Response(data, {
			status: 200,
			headers: {
				"content-type": getMimeType(filePath),
				"cache-control": isHashed
					? "public, max-age=31536000, immutable"
					: "public, max-age=3600",
			},
		})
	} catch (err) {
		if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return null
		throw err
	}
}

serve(
	{
		fetch: async (req) => {
			const assetResponse = await tryServeStaticFile(req)
			return assetResponse ?? server.fetch(req)
		},
		port,
		hostname,
	},
	(info) => {
		console.log(`Listening on http://${hostname}:${info.port}`)
	},
)
