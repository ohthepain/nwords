import { Link } from "@tanstack/react-router"
import { cn } from "~/lib/utils"

type AppHeaderBrandProps = {
	className?: string
	/** Narrower type scale for dense toolbars (e.g. authed `h-14` bar). */
	compact?: boolean
}

/** Top-left app mark; navigates to the marketing home page. */
export function AppHeaderBrand({ className, compact }: AppHeaderBrandProps) {
	return (
		<Link
			to="/"
			className={cn(
				"flex items-center gap-1.5 group shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				className,
			)}
			aria-label="nwords.live home"
		>
			<span
				className={cn(
					"font-bold tracking-tight",
					compact ? "text-base sm:text-lg" : "text-xl",
				)}
			>
				nwords
			</span>
			<span
				className={cn(
					"text-muted-foreground font-mono opacity-60 group-hover:opacity-100 transition-opacity",
					compact ? "text-[10px] sm:text-xs" : "text-xs",
				)}
			>
				.live
			</span>
		</Link>
	)
}
