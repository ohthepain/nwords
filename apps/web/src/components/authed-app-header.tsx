import { Link, useNavigate } from "@tanstack/react-router"
import { Bug, LogOut, UserRound } from "lucide-react"
import { AppHeaderBrand } from "~/components/header"
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
import { cn } from "~/lib/utils"
import { useDevStore } from "~/stores/dev"

export type AuthedAppHeaderUser = {
	id: string
	name: string
	email?: string | null
}

type AuthedAppHeaderProps = {
	pageTitle: string
	user: AuthedAppHeaderUser
	isAdmin: boolean
	/** Called after `signOut` succeeds, before navigation. */
	onAfterSignOut?: () => void
	/** Where to send the user after sign-out. */
	signOutNavigateTo?: "/" | "/practice"
}

export function AuthedAppHeader({
	pageTitle,
	user,
	isAdmin,
	onAfterSignOut,
	signOutNavigateTo = "/",
}: AuthedAppHeaderProps) {
	const navigate = useNavigate()
	const devMode = useDevStore((s) => s.devMode)
	const toggleDevMode = useDevStore((s) => s.toggleDevMode)

	async function handleSignOut() {
		await authClient.signOut()
		onAfterSignOut?.()
		navigate({ to: signOutNavigateTo, replace: true })
	}

	return (
		<header className="shrink-0 border-b border-border/50 backdrop-blur-sm sticky top-0 z-10 bg-background/80">
			<div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3 sm:gap-4">
				<AppHeaderBrand compact />
				<h1 className="text-base sm:text-lg font-semibold tracking-tight min-w-0 truncate flex-1">
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
	)
}
