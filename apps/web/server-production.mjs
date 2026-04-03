/**
 * TanStack Start's Vite build emits a Web Fetch handler only (no HTTP listen).
 * Running `node dist/server/server.js` loads the module and exits 0 — ECS sees
 * "Essential container exited" with no CloudWatch logs. This file binds the
 * handler to Node's HTTP server (0.0.0.0 for Fargate/ALB health checks).
 */
import { serve } from "@hono/node-server"
import server from "./dist/server/server.js"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const port = Number(process.env.PORT) || 3000
const hostname = process.env.HOST ?? "0.0.0.0"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// TanStack Start's production fetch handler renders HTML routes but does not
// automatically serve Vite's static client assets. Serve them explicitly so
// CSS/JS are available at their hashed `/assets/...` URLs.
const viteAssetsDir = path.join(__dirname, "dist", "client", "assets")

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

async function tryServeViteAsset(req) {
	const url = new URL(req.url)
	const pathname = url.pathname
	if (!pathname.startsWith("/assets/")) return null

	// Drop `/assets/` prefix, then safely map to `dist/client/assets`.
	const relPathRaw = pathname.slice("/assets/".length)
	if (!relPathRaw) return null

	// Best-effort decoding; if it fails, treat it as not found.
	let relPath
	try {
		relPath = decodeURIComponent(relPathRaw)
	} catch {
		return null
	}

	// Prevent path traversal (e.g. `/assets/../server.js`).
	const filePath = path.resolve(viteAssetsDir, relPath)
	if (!filePath.startsWith(viteAssetsDir + path.sep)) return null

	try {
		const data = await fs.readFile(filePath)
		return new Response(data, {
			status: 200,
			headers: {
				"content-type": getMimeType(filePath),
				// Hashed filenames can be aggressively cached.
				"cache-control": "public, max-age=31536000, immutable",
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
			const assetResponse = await tryServeViteAsset(req)
			return assetResponse ?? server.fetch(req)
		},
		port,
		hostname,
	},
	(info) => {
		console.log(`Listening on http://${hostname}:${info.port}`)
	},
)
