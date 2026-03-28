import posthog from "posthog-js"

let initialized = false

export function initPostHog() {
	if (initialized || typeof window === "undefined") return

	const key = import.meta.env.VITE_POSTHOG_KEY
	const host = import.meta.env.VITE_POSTHOG_HOST

	if (!key) return

	posthog.init(key, {
		api_host: host || "https://eu.i.posthog.com",
		capture_pageview: true,
		capture_pageleave: true,
		persistence: "localStorage",
	})

	initialized = true
}

export { posthog }
