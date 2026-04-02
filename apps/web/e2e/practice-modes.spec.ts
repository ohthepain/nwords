import { expect, test } from "@playwright/test";

const mockUser = {
	id: "e2e-user",
	name: "E2E User",
	email: "e2e@example.com",
	role: "USER",
	nativeLanguage: { id: "lang-native", name: "English", code: "en" },
	targetLanguage: { id: "lang-target", name: "Spanish", code: "es" },
};

const mockLanguages = {
	languages: [
		{ id: "lang-native", name: "English", code: "en" },
		{ id: "lang-target", name: "Spanish", code: "es" },
		{ id: "lang-other", name: "French", code: "fr" },
	],
};

test.beforeEach(async ({ page }) => {
	await page.route("**/api/user/me", async (route) => {
		if (route.request().method() !== "GET") {
			await route.continue();
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(mockUser),
		});
	});
	await page.route("**/api/languages?enabled=true**", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(mockLanguages),
		});
	});
	await page.route("**/api/settings", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ showHints: false }),
		});
	});
});

const modeCases = [
	{
		search: "?vocabMode=ASSESSMENT",
		title: "Assessment",
		description: "binary search",
	},
	{
		search: "?vocabMode=BUILD",
		title: "Build vocabulary",
		description: "Fill the blank",
	},
	{
		search: "?vocabMode=FRUSTRATION",
		title: "Frustration words",
		description: "stubbornest words",
	},
] as const;

test("practice page shows copy for each vocab mode", async ({ page }) => {
	for (const { search, title, description } of modeCases) {
		await page.goto(`/practice${search}`, { waitUntil: "networkidle" });
		await expect(page.getByText(title, { exact: true })).toBeVisible();
		await expect(page.getByText(new RegExp(description, "i"))).toBeVisible();
	}
});

test("practice page defaults invalid vocabMode to build", async ({ page }) => {
	await page.goto("/practice?vocabMode=not-a-mode", { waitUntil: "networkidle" });
	await expect(page.getByText("Build vocabulary", { exact: true })).toBeVisible();
	await expect(page.getByText(/Fill the blank/i)).toBeVisible();
});
