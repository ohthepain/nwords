import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { useEffect, useLayoutEffect } from "react"
import { VocabGraphThemeSync } from "~/components/vocab-graph-theme-sync"
import { initPostHog } from "~/lib/posthog"
import { useEffectiveDark, useThemeStore } from "~/stores/theme"
import "~/styles.css"

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "nwords.live — Count Your Vocabulary" },
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
	const dark = useEffectiveDark()
	const uiStyle = useThemeStore((s) => s.uiStyle)

	useEffect(() => {
		initPostHog()
	}, [])

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
