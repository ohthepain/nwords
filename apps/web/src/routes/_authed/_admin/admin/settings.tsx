import { Link, createFileRoute } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"

export const Route = createFileRoute("/_authed/_admin/admin/settings")({
	component: AdminSiteSettingsPage,
})

type AppSettingsResponse = {
	id: string
	showHints: boolean
	updatedAt: string
}

function AdminSiteSettingsPage() {
	const [settings, setSettings] = useState<AppSettingsResponse | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const [saveError, setSaveError] = useState<string | null>(null)

	const load = useCallback(async () => {
		setLoadError(null)
		const res = await fetch("/api/admin/settings", { credentials: "include" })
		if (!res.ok) {
			setLoadError(res.status === 403 ? "Admin access required." : "Could not load settings.")
			setSettings(null)
			return
		}
		const data = (await res.json()) as AppSettingsResponse
		setSettings(data)
	}, [])

	useEffect(() => {
		void load()
	}, [load])

	async function saveShowHints(next: boolean) {
		if (!settings) return
		setSaving(true)
		setSaveError(null)
		const res = await fetch("/api/admin/settings", {
			method: "PATCH",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ showHints: next }),
		})
		setSaving(false)
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string }
			setSaveError(body.error ?? "Save failed.")
			return
		}
		const data = (await res.json()) as AppSettingsResponse
		setSettings(data)
	}

	return (
		<div className="max-w-xl mx-auto px-6 py-8 space-y-6">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h1 className="text-lg font-semibold tracking-tight">Site settings</h1>
					<p className="text-sm text-muted-foreground mt-1">
						Deployment-wide flags. Changes apply to all users immediately.
					</p>
				</div>
				<Button variant="outline" size="sm" asChild>
					<Link to="/admin">Admin home</Link>
				</Button>
			</div>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">Cloze practice</CardTitle>
					<CardDescription>
						Inline blank hints (native-language gloss in the sentence). The hint sentence below the
						prompt is not affected.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{loadError && (
						<p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
							{loadError}
						</p>
					)}
					{settings && (
						<label className="flex items-start gap-3 cursor-pointer select-none">
							<input
								type="checkbox"
								checked={settings.showHints}
								disabled={saving}
								onChange={(e) => void saveShowHints(e.target.checked)}
								className="mt-1 rounded border-border shrink-0"
							/>
							<div className="space-y-1">
								<span className="text-sm font-medium leading-tight block">Show inline blank hints</span>
								<p className="text-xs text-muted-foreground font-mono tabular-nums">
									Last updated: {new Date(settings.updatedAt).toLocaleString()}
								</p>
							</div>
						</label>
					)}
					{saveError && (
						<p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
							{saveError}
						</p>
					)}
					{settings && saving ? (
						<p className="text-xs text-muted-foreground">Saving…</p>
					) : null}
				</CardContent>
			</Card>
		</div>
	)
}
