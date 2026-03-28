import {
	HeadContent,
	Outlet,
	Scripts,
	ScrollRestoration,
	createRootRoute,
} from "@tanstack/react-router"
import type { ReactNode } from "react"

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
				href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap",
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
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	)
}

function RootComponent() {
	return (
		<RootDocument>
			<div className="min-h-screen flex flex-col">
				<Outlet />
			</div>
		</RootDocument>
	)
}
