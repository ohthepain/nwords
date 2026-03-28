import path from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { defineConfig } from "vitest/config"

const dir = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.join(dir, "../../.env") })

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
	},
})
