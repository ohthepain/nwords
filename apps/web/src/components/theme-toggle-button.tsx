import { Moon, Sun } from "lucide-react"
import { Button } from "~/components/ui/button"
import { cn } from "~/lib/utils"
import { useThemeStore } from "~/stores/theme"

export function ThemeToggleButton({ className }: { className?: string }) {
	const dark = useThemeStore((s) => s.dark)
	const toggleDark = useThemeStore((s) => s.toggleDark)

	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			className={cn("text-muted-foreground", className)}
			onClick={toggleDark}
			aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
		>
			{dark ? <Sun className="size-[1.125rem]" /> : <Moon className="size-[1.125rem]" />}
		</Button>
	)
}
