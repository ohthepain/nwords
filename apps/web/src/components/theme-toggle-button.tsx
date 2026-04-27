import { Monitor, Moon, Sun } from "lucide-react"
import { Button } from "~/components/ui/button"
import { cn } from "~/lib/utils"
import { type ColorScheme, useThemeStore } from "~/stores/theme"

const OPTIONS: { scheme: ColorScheme; label: string; icon: typeof Sun }[] = [
	{ scheme: "light", label: "Light", icon: Sun },
	{ scheme: "dark", label: "Dark", icon: Moon },
	{ scheme: "system", label: "System (match device)", icon: Monitor },
]

export function ThemeToggleButton({ className }: { className?: string }) {
	const colorScheme = useThemeStore((s) => s.colorScheme)
	const setColorScheme = useThemeStore((s) => s.setColorScheme)

	return (
		<fieldset
			className={cn(
				"m-0 min-w-0 border border-border p-0.5 inline-flex items-center rounded-md bg-muted/40 shadow-xs",
				className,
			)}
			aria-label="Color scheme"
		>
			{OPTIONS.map(({ scheme, label, icon: Icon }) => {
				const selected = colorScheme === scheme
				return (
					<Button
						key={scheme}
						type="button"
						variant="ghost"
						size="icon"
						className={cn(
							"size-8 rounded-sm shrink-0",
							selected && "bg-background text-foreground shadow-sm",
						)}
						aria-pressed={selected}
						aria-label={label}
						title={label}
						onClick={() => setColorScheme(scheme)}
					>
						<Icon className="size-[1.125rem]" aria-hidden />
					</Button>
				)
			})}
		</fieldset>
	)
}
