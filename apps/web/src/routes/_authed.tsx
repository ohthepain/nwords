import { Outlet, Link, createFileRoute, redirect, useNavigate } from "@tanstack/react-router"
import { Button } from "~/components/ui/button"
import { getSession } from "~/lib/auth-session"
import { authClient } from "~/lib/auth-client"

export const Route = createFileRoute("/_authed")({
	beforeLoad: async () => {
		const session = await getSession()
		if (!session?.user) {
			throw redirect({ to: "/auth/login" })
		}
		return { user: session.user }
	},
	component: AuthedLayout,
})

function AuthedLayout() {
	const { user } = Route.useRouteContext()
	const navigate = useNavigate()

	async function handleSignOut() {
		await authClient.signOut()
		navigate({ to: "/" })
	}

	return (
		<div className="flex-1 flex flex-col">
			<header className="border-b border-border/50 backdrop-blur-sm sticky top-0 z-10 bg-background/80">
				<div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
					<div className="flex items-center gap-8">
						<Link to="/dashboard" className="flex items-center gap-1.5 group">
							<span className="text-lg font-bold tracking-tight">nwords</span>
							<span className="text-xs text-muted-foreground font-mono opacity-50 group-hover:opacity-100 transition-opacity">
								.live
							</span>
						</Link>
						<nav className="flex items-center gap-1">
							<NavLink to="/dashboard">Dashboard</NavLink>
							<NavLink to="/settings">Settings</NavLink>
						</nav>
					</div>
					<div className="flex items-center gap-3">
						<div className="flex items-center gap-2">
							<div className="size-7 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
								{user.name.charAt(0).toUpperCase()}
							</div>
							<span className="text-sm text-muted-foreground hidden sm:block">
								{user.name}
							</span>
						</div>
						<Button
							variant="ghost"
							size="sm"
							onClick={handleSignOut}
							className="text-muted-foreground hover:text-foreground"
						>
							Sign out
						</Button>
					</div>
				</div>
			</header>
			<main className="flex-1">
				<Outlet />
			</main>
		</div>
	)
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
	return (
		<Link
			to={to}
			className="text-sm px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors [&.active]:text-foreground [&.active]:bg-accent"
		>
			{children}
		</Link>
	)
}
