import {
	Link,
	Outlet,
	createFileRoute,
	redirect,
	useMatches,
	useNavigate,
} from "@tanstack/react-router"
import { Bug, LogOut, UserRound } from "lucide-react"
import { ThemeToggleButton } from "~/components/theme-toggle-button"
import { Button } from "~/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"
import { authClient } from "~/lib/auth-client"
import { getAuthedLayoutData } from "~/lib/auth-session"
import { authedPageTitleForRouteId } from "~/lib/authed-page-title"
import { cn } from "~/lib/utils"
import { useDevStore } from "~/stores/dev"
export const Route = createFileRoute("/_authed")({
	beforeLoad: async () => {
		const data = await getAuthedLayoutData()
		if (!data) {
			throw redirect({ to: "/auth/login" })
		}
		return data
	},
	component: AuthedLayout,
})

function AuthedLayout() {
	const { user, isAdmin } = Route.useRouteContext()
	const navigate = useNavigate()
	const devMode = useDevStore((s) => s.devMode)
	const toggleDevMode = useDevStore((s) => s.toggleDevMode)

	const matches = useMatches()
	const leaf = matches.at(-1)
	const pageTitle = authedPageTitleForRouteId(leaf?.routeId)

	async function handleSignOut() {
		await authClient.signOut()
		navigate({ to: "/" })
	}

	return (
		<div className="flex-1 flex flex-col">
			<header className="border-b border-border/50 backdrop-blur-sm sticky top-0 z-10 bg-background/80">
				<div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-4">
					<h1 className="text-base sm:text-lg font-semibold tracking-tight shrink-0 min-w-0 truncate mr-auto">
						{pageTitle}
					</h1>
					<div className="flex items-center gap-1 sm:gap-2 shrink-0">
						<ThemeToggleButton />
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className={cn("text-muted-foreground", devMode && "text-brand bg-brand/10")}
							onClick={toggleDevMode}
							aria-label={devMode ? "Disable dev mode" : "Enable dev mode"}
							title="Dev mode"
						>
							<Bug className="size-[1.125rem]" />
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="text-muted-foreground"
									aria-label="Account menu"
								>
									<UserRound className="size-[1.25rem]" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-56">
								<DropdownMenuLabel className="font-normal">
									<div className="flex flex-col gap-0.5">
										<span className="text-sm font-medium text-foreground">{user.name}</span>
										{user.email && (
											<span className="text-xs text-muted-foreground font-normal truncate">
												{user.email}
											</span>
										)}
										{devMode && (
											<span className="text-[10px] font-mono text-muted-foreground/90 pt-1 break-all">
												id: {user.id}
											</span>
										)}
									</div>
								</DropdownMenuLabel>
								<DropdownMenuSeparator />
								<DropdownMenuItem asChild>
									<Link to="/settings">Settings</Link>
								</DropdownMenuItem>
								{isAdmin && (
									<DropdownMenuItem asChild>
										<Link to="/admin">Admin</Link>
									</DropdownMenuItem>
								)}
								<DropdownMenuSeparator />
								<DropdownMenuItem variant="destructive" onSelect={() => void handleSignOut()}>
									<LogOut className="size-4 opacity-70" />
									Sign out
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
			</header>
			<main className="flex-1">
				<Outlet />
			</main>
		</div>
	)
}
