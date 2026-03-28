import { auth } from "@nwords/auth/server"
import { prisma } from "@nwords/db"
import { createFileRoute } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { useState } from "react"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { Label } from "~/components/ui/label"
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select"
import { Separator } from "~/components/ui/separator"
import { UI_STYLES, useThemeStore } from "~/stores/theme"

const getSettingsData = createServerFn({ method: "GET" }).handler(async () => {
	const request = getRequest()
	if (!request) return null
	const session = await auth.api.getSession({ headers: request.headers })
	if (!session?.user?.id) return null

	const [user, languages] = await Promise.all([
		prisma.user.findUnique({
			where: { id: session.user.id },
			select: {
				nativeLanguageId: true,
				targetLanguageId: true,
			},
		}),
		prisma.language.findMany({
			orderBy: { name: "asc" },
			select: { id: true, code: true, name: true, enabled: true },
		}),
	])

	return {
		nativeLanguageId: user?.nativeLanguageId ?? null,
		targetLanguageId: user?.targetLanguageId ?? null,
		languages,
	}
})

const updateLanguages = createServerFn({ method: "POST" })
	.inputValidator((data: { nativeLanguageId: string; targetLanguageId: string }) => data)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) return { success: false }
		const session = await auth.api.getSession({ headers: request.headers })
		if (!session?.user?.id) return { success: false }

		if (data.nativeLanguageId === data.targetLanguageId) {
			return { success: false, error: "Languages must be different" }
		}

		await prisma.user.update({
			where: { id: session.user.id },
			data: {
				nativeLanguageId: data.nativeLanguageId,
				targetLanguageId: data.targetLanguageId,
			},
		})

		return { success: true }
	})

export const Route = createFileRoute("/_authed/settings")({
	loader: () => getSettingsData(),
	component: SettingsPage,
})

function SettingsPage() {
	const data = Route.useLoaderData()
	const { dark, toggleDark, uiStyle, setUiStyle } = useThemeStore()

	const [nativeId, setNativeId] = useState(data?.nativeLanguageId ?? "")
	const [targetId, setTargetId] = useState(data?.targetLanguageId ?? "")
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [saved, setSaved] = useState(false)

	if (!data) return null

	const allLanguages = data.languages
	const enabledLanguages = data.languages.filter((l) => l.enabled)

	async function handleSave() {
		if (!nativeId || !targetId) {
			setError("Please select both languages")
			return
		}
		setSaving(true)
		setError(null)
		setSaved(false)

		const result = await updateLanguages({
			data: { nativeLanguageId: nativeId, targetLanguageId: targetId },
		})

		setSaving(false)
		if (result.success) {
			setSaved(true)
			setTimeout(() => setSaved(false), 2000)
		} else {
			setError(result.error ?? "Failed to save")
		}
	}

	return (
		<div className="max-w-2xl mx-auto px-6 py-8 space-y-6">
			<div>
				<h1 className="text-2xl font-bold">Settings</h1>
				<p className="text-sm text-muted-foreground mt-1">
					Configure your languages and appearance
				</p>
			</div>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">Languages</CardTitle>
					<CardDescription>
						Choose your native language and the language you want to study
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<div className="space-y-2">
							<Label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
								I speak
							</Label>
							<Select value={nativeId} onValueChange={setNativeId}>
								<SelectTrigger className="h-10">
									<SelectValue placeholder="Select language" />
								</SelectTrigger>
								<SelectContent>
									{allLanguages.map((lang) => (
										<SelectItem key={lang.id} value={lang.id}>
											{lang.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="space-y-2">
							<Label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
								I want to study
							</Label>
							<Select value={targetId} onValueChange={setTargetId}>
								<SelectTrigger className="h-10">
									<SelectValue placeholder="Select language" />
								</SelectTrigger>
								<SelectContent>
									{enabledLanguages.length === 0 ? (
										<SelectItem value="none" disabled>
											No languages available yet
										</SelectItem>
									) : (
										enabledLanguages.map((lang) => (
											<SelectItem key={lang.id} value={lang.id}>
												{lang.name}
											</SelectItem>
										))
									)}
								</SelectContent>
							</Select>
						</div>
					</div>

					{enabledLanguages.length === 0 && (
						<p className="text-xs text-muted-foreground bg-muted rounded-md px-3 py-2">
							Languages are enabled by admins once vocabulary data has been imported.
						</p>
					)}

					{error && (
						<p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
							{error}
						</p>
					)}

					<div className="flex items-center gap-3">
						<Button onClick={handleSave} disabled={saving} className="h-9">
							{saving ? "Saving..." : saved ? "Saved" : "Save languages"}
						</Button>
						{saved && (
							<span className="text-xs text-known font-medium animate-count-up">Changes saved</span>
						)}
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">Appearance</CardTitle>
					<CardDescription>Customize how nwords looks</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					<div className="flex items-center justify-between">
						<div>
							<Label>Dark mode</Label>
							<p className="text-xs text-muted-foreground mt-0.5">
								{dark ? "Currently using dark theme" : "Currently using light theme"}
							</p>
						</div>
						<Button variant="outline" size="sm" onClick={toggleDark} className="font-mono text-xs">
							{dark ? "Switch to light" : "Switch to dark"}
						</Button>
					</div>

					<Separator />

					<div className="space-y-2">
						<Label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
							UI Style
						</Label>
						<Select value={uiStyle} onValueChange={(v) => setUiStyle(v as typeof uiStyle)}>
							<SelectTrigger className="h-10 max-w-xs">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{UI_STYLES.map((style) => (
									<SelectItem key={style} value={style}>
										{style.charAt(0).toUpperCase() + style.slice(1)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="text-xs text-muted-foreground">
							Changes how UI elements are rendered across the app
						</p>
					</div>
				</CardContent>
			</Card>
		</div>
	)
}
