import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
/** Set PLAYWRIGHT_SKIP_WEB_SERVER=1 when something else already serves `baseURL`. */
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "1";

export default defineConfig({
	testDir: "e2e",
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	reporter: [
		["list"],
		["html", { open: "never", outputFolder: path.join("output", "playwright", "report") }],
	],
	outputDir: path.join("output", "playwright", "artifacts"),
	use: {
		baseURL,
		trace: "on-first-retry",
		screenshot: "only-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: skipWebServer
		? undefined
		: {
				command: "pnpm exec vite dev --host 127.0.0.1 --port 3000 --strictPort",
				cwd: __dirname,
				url: baseURL,
				reuseExistingServer: !process.env.CI,
				timeout: 120_000,
			},
});
