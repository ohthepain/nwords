import { Link, useRouter } from "@tanstack/react-router"
import { ArrowRight, Check, Globe } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { AppHeaderProfileMenu } from "~/components/app-header-profile-menu"
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
import { isLocalDevEnvironment } from "~/lib/dev-mode-access"
import { languageCodeToFlagEmoji } from "~/lib/language-flag"
import { cn } from "~/lib/utils"
import { useDevStore } from "~/stores/dev"

export type AuthedAppHeaderUser = {
	id: string
	name: string
	email?: string | null
}

export type AuthedAppHeaderLanguage = {
	id: string
	code: string
}

/** @deprecated Use `AuthedAppHeaderLanguage` instead. */
export type AuthedAppHeaderNativeLanguage = AuthedAppHeaderLanguage

type HeaderLanguageRow = { id: string; code: string; name: string }

type AuthedAppHeaderProps = {
	pageTitle: string
	user: AuthedAppHeaderUser
	isAdmin: boolean
	/** Better Auth anonymous guest — prompt to register to keep progress across devices. */
	isAnonymous?: boolean
	/** Summary of the user's native language for the flag control (null if unset). */
	nativeLanguage: AuthedAppHeaderLanguage | null
	/** Summary of the user's target language (null if unset). */
	targetLanguage: AuthedAppHeaderLanguage | null
	/** When native language is changed from the header, run after a successful API update (e.g. sync local practice state). Router layout data is also invalidated. */
	onNativeLanguageUpdated?: (next: { id: string; code: string; name: string }) => void
	/** Called after `signOut` succeeds, before navigation. */
	onAfterSignOut?: () => void
	/** Where to send the user after sign-out. */
	signOutNavigateTo?: "/" | "/practice"
}

function NativeLanguageMenuButton({
	nativeLanguage,
	onNativeLanguageUpdated,
}: {
	nativeLanguage: AuthedAppHeaderLanguage | null
	onNativeLanguageUpdated?: (next: { id: string; code: string; name: string }) => void
}) {
	const router = useRouter()
	const [menuOpen, setMenuOpen] = useState(false)
	const [rows, setRows] = useState<HeaderLanguageRow[]>([])
	const [loadError, setLoadError] = useState<string | null>(null)
	const [saveError, setSaveError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	const loadLanguages = useCallback(async () => {
		setLoadError(null)
		try {
			const res = await fetch("/api/languages")
			if (!res.ok) {
				setLoadError("Could not load languages.")
				return
			}
			const data = (await res.json()) as { languages: HeaderLanguageRow[] }
			setRows(data.languages)
		} catch {
			setLoadError("Could not load languages.")
		}
	}, [])

	useEffect(() => {
		if (!menuOpen || rows.length > 0) return
		void loadLanguages()
	}, [menuOpen, rows.length, loadLanguages])

	async function selectLanguage(id: string) {
		if (id === nativeLanguage?.id || busy) return
		setBusy(true)
		setSaveError(null)
		try {
			const res = await fetch("/api/user/me/native-language", {
				method: "PATCH",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ nativeLanguageId: id }),
			})
			const body = (await res.json().catch(() => ({}))) as {
				error?: string
				nativeLanguage?: HeaderLanguageRow
			}
			if (!res.ok) {
				setSaveError(body.error ?? "Could not update your language.")
				setBusy(false)
				return
			}
			if (body.nativeLanguage) {
				onNativeLanguageUpdated?.(body.nativeLanguage)
			}
			await router.invalidate()
			setMenuOpen(false)
		} catch {
			setSaveError("Could not update your language.")
		} finally {
			setBusy(false)
		}
	}

	const flag = nativeLanguage ? languageCodeToFlagEmoji(nativeLanguage.code) : null

	return (
		<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="text-muted-foreground text-xl leading-none"
					aria-label={nativeLanguage ? "Change your language" : "Choose your language"}
					title={nativeLanguage ? "Your language" : "Choose your language"}
				>
					{flag ? (
						<span aria-hidden className="relative top-px text-[1.35rem] leading-none select-none">
							{flag}
						</span>
					) : (
						<Globe className="size-[1.25rem]" aria-hidden />
					)}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-56">
				<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
					Your language
				</DropdownMenuLabel>
				{loadError && <p className="px-2 py-1.5 text-xs text-destructive">{loadError}</p>}
				{saveError && <p className="px-2 py-1.5 text-xs text-destructive">{saveError}</p>}
				<DropdownMenuSeparator />
				{rows.length === 0 && !loadError ? (
					<p className="px-2 py-2 text-xs text-muted-foreground">Loading…</p>
				) : (
					rows.map((row) => {
						const selected = row.id === nativeLanguage?.id
						return (
							<DropdownMenuItem
								key={row.id}
								disabled={busy}
								onSelect={() => void selectLanguage(row.id)}
								className="gap-2"
							>
								<span aria-hidden className="text-base leading-none w-7 text-center select-none">
									{languageCodeToFlagEmoji(row.code)}
								</span>
								<span className="flex-1 min-w-0 truncate">{row.name}</span>
								{selected ? <Check className="size-4 shrink-0 opacity-80" /> : null}
							</DropdownMenuItem>
						)
					})
				)}
				<DropdownMenuSeparator />
				<DropdownMenuItem asChild>
					<Link to="/settings">Language and account settings</Link>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

export function AuthedAppHeader({
	pageTitle,
	user,
	isAdmin,
	isAnonymous = false,
	nativeLanguage,
	targetLanguage,
	onNativeLanguageUpdated,
	onAfterSignOut,
	signOutNavigateTo = "/",
}: AuthedAppHeaderProps) {
	const devMode = useDevStore((s) => s.devMode)
	const toggleDevMode = useDevStore((s) => s.toggleDevMode)
	const canToggleDevMode = isAdmin || isLocalDevEnvironment()

	return (
		<header className="shrink-0 border-b border-border/50 backdrop-blur-sm sticky top-0 z-10 bg-background/80">
			<div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3 sm:gap-4">
				<AppHeaderBrand compact />
				<h1 className="text-base sm:text-lg font-semibold tracking-tight min-w-0 truncate flex-1">
					{pageTitle}
				</h1>
				<div className="flex items-center gap-1 sm:gap-2 shrink-0">
					<div className="flex items-center gap-1">
						<NativeLanguageMenuButton
							nativeLanguage={nativeLanguage}
							onNativeLanguageUpdated={onNativeLanguageUpdated}
						/>
						{targetLanguage && (
							<>
								<ArrowRight className="size-3.5 text-muted-foreground/60 shrink-0" aria-hidden />
								<span
									aria-label="Target language"
									title="Target language"
									className="text-[1.35rem] leading-none select-none relative top-px"
								>
									{languageCodeToFlagEmoji(targetLanguage.code)}
								</span>
							</>
						)}
					</div>
					<ThemeToggleButton />
					{canToggleDevMode && (
						<Button
							type="button"
							variant={devMode ? "default" : "outline"}
							size="xs"
							className={cn(
								"min-w-[2.75rem] rounded-sm px-2 font-mono text-[10px] font-semibold tracking-wide uppercase",
								devMode && "shadow-xs",
							)}
							onClick={toggleDevMode}
							aria-pressed={devMode}
							aria-label={devMode ? "Disable dev mode" : "Enable dev mode"}
							title={
								isAdmin
									? "Toggle dev mode (admin)"
									: "Toggle dev mode (available on this machine only)"
							}
						>
							Dev
						</Button>
					)}
					<AppHeaderProfileMenu
						user={user}
						isAdmin={isAdmin}
						isAnonymous={isAnonymous}
						onAfterSignOut={onAfterSignOut}
						signOutNavigateTo={signOutNavigateTo}
					/>
				</div>
			</div>
		</header>
	)
}
