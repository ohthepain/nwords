import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { useEffect, useLayoutEffect } from "react"
import { VocabGraphThemeSync } from "~/components/vocab-graph-theme-sync"
import { initPostHog } from "~/lib/posthog"
import { useThemeStore } from "~/stores/theme"
import "~/styles.css"

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "nwords.live — Know Your Vocabulary" },
			{
				name: "description",
				content:
					"A precision vocabulary testing tool. Measure, track, and expand your vocabulary in any language.",
			},
		],
		links: [
			{ rel: "icon", href: "/logo.png", type: "image/png" },
			{ rel: "apple-touch-icon", href: "/logo.png" },
			{
				rel: "preconnect",
				href: "https://fonts.googleapis.com",
			},
			{
				rel: "preconnect",
				href: "https://fonts.gstatic.com",
				crossOrigin: "anonymous",
			},
			{
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Newsreader:opsz,wght@6..72,400;600&display=swap",
			},
		],
	}),
	component: RootComponent,
})

function RootDocument({ children }: { children: ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<HeadContent />
			</head>
			<body>
				{children}
				<Scripts />
			</body>
		</html>
	)
}

function RootComponent() {
	const dark = useThemeStore((s) => s.dark)
	const uiStyle = useThemeStore((s) => s.uiStyle)

	useEffect(() => {
		initPostHog()
	}, [])

	// #region agent log
	useEffect(() => {
		void (async () => {
			const iconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
			const send = (message: string, data: Record<string, unknown>, hypothesisId: string) => {
				void fetch("http://127.0.0.1:7758/ingest/99baccff-1168-49a3-aecb-775311639d96", {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "c96f36" },
					body: JSON.stringify({
						sessionId: "c96f36",
						location: "__root.tsx:favicon-debug",
						message,
						data,
						timestamp: Date.now(),
						hypothesisId,
					}),
				}).catch(() => {})
			}
			send(
				"icon link in DOM after load",
				{ href: iconLink?.getAttribute("href") ?? null, typeAttr: iconLink?.getAttribute("type") ?? null },
				"B",
			)
			for (const path of ["/logo.png", "/logo.svg", "/favicon.ico"] as const) {
				try {
					const r = await fetch(path, { method: "HEAD", cache: "no-store" })
					send("HEAD asset", { path, status: r.status, ok: r.ok }, path === "/favicon.ico" ? "C" : "A")
				} catch (err) {
					send("HEAD asset error", { path, err: String(err) }, path === "/favicon.ico" ? "C" : "A")
				}
			}
		})()
	}, [])
	// #endregion

	useEffect(() => {
		document.documentElement.classList.toggle("dark", dark)
	}, [dark])

	useLayoutEffect(() => {
		const apple = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')
		if (apple) {
			apple.href = dark ? "/logo-white.png" : "/logo.png"
		}
	}, [dark])

	useEffect(() => {
		document.documentElement.dataset.uiStyle = uiStyle
	}, [uiStyle])

	return (
		<RootDocument>
			<div className="min-h-screen flex flex-col">
				<VocabGraphThemeSync />
				<Outlet />
				{import.meta.env.DEV && (
					<div className="fixed bottom-1 right-2 text-[10px] font-mono text-muted-foreground/50 select-none pointer-events-none">
						{__GIT_HASH__}
					</div>
				)}
			</div>
		</RootDocument>
	)
}
