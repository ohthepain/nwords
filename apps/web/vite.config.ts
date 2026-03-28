import path from "node:path"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import { defineConfig, loadEnv } from "vite"
import tsConfigPaths from "vite-tsconfig-paths"

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const dbPackageRoot = path.join(monorepoRoot, "packages/db")

/** Workspace packages (e.g. @nwords/db) read `process.env`; Vite only injects .env into `import.meta.env` unless we merge here. */
function mergeEnvIntoProcessEnv(mode: string, envDir: string) {
	for (const [key, value] of Object.entries(loadEnv(mode, envDir, ""))) {
		if (process.env[key] === undefined) {
			process.env[key] = value
		}
	}
}

export default defineConfig(({ mode }) => {
	mergeEnvIntoProcessEnv(mode, monorepoRoot)
	mergeEnvIntoProcessEnv(mode, dbPackageRoot)

	return {
		envDir: monorepoRoot,
		server: {
			port: 3000,
		},
		plugins: [
			tanstackStart(),
			tsConfigPaths({
				projects: ["./tsconfig.json"],
			}),
			tailwindcss(),
		],
	}
})
