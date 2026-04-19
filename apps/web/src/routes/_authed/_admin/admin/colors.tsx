import { Link, createFileRoute } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { VocabGraphColorsCard } from "~/components/settings/vocab-graph-colors-card"
import { Button } from "~/components/ui/button"
import { useThemeStore } from "~/stores/theme"
import {
	type VocabGraphColors,
	VOCAB_GRAPH_THEME_DEFAULTS,
	useVocabGraphAppearanceStore,
} from "~/stores/vocab-graph-appearance"

export const Route = createFileRoute("/_authed/_admin/admin/colors")({
	component: AdminColorsPage,
})

type AppSettingsColors = { vocabGraphColors: VocabGraphColors | null }
type Language = { id: string; name: string; enabled: boolean }

function AdminColorsPage() {
	const dark = useThemeStore((s) => s.dark)
	const setGlobalColors = useVocabGraphAppearanceStore((s) => s.setColors)

	const [savedColors, setSavedColors] = useState<VocabGraphColors>(VOCAB_GRAPH_THEME_DEFAULTS.light)
	const [draft, setDraft] = useState<VocabGraphColors>(VOCAB_GRAPH_THEME_DEFAULTS.light)
	const [languages, setLanguages] = useState<Language[]>([])
	const [previewLanguageId, setPreviewLanguageId] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [saved, setSaved] = useState(false)

	const load = useCallback(async () => {
		setError(null)
		const [settingsRes, langsRes] = await Promise.all([
			fetch("/api/admin/settings", { credentials: "include" }),
			fetch("/api/admin/languages", { credentials: "include" }),
		])
		if (!settingsRes.ok) {
			setError(settingsRes.status === 403 ? "Admin access required." : "Could not load settings.")
			return
		}
		const settingsData = (await settingsRes.json()) as AppSettingsColors
		const colors =
			settingsData.vocabGraphColors ?? VOCAB_GRAPH_THEME_DEFAULTS[dark ? "dark" : "light"]
		setSavedColors(structuredClone(colors))
		setDraft(structuredClone(colors))

		if (langsRes.ok) {
			const langsData = (await langsRes.json()) as { languages: Language[] }
			const enabled = langsData.languages.filter((l) => l.enabled)
			setLanguages(enabled)
			if (enabled.length > 0) setPreviewLanguageId(enabled[0].id)
		}
	}, [dark])

	useEffect(() => {
		void load()
	}, [load])

	async function save() {
		setSaving(true)
		setError(null)
		setSaved(false)
		const res = await fetch("/api/admin/settings", {
			method: "PATCH",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ vocabGraphColors: draft }),
		})
		setSaving(false)
		if (!res.ok) {
			const b = (await res.json().catch(() => ({}))) as { error?: string }
			setError(b.error ?? "Save failed.")
			return
		}
		const data = (await res.json()) as AppSettingsColors
		const saved = data.vocabGraphColors ?? draft
		setSavedColors(structuredClone(saved))
		setDraft(structuredClone(saved))
		setGlobalColors(saved)
		setSaved(true)
		setTimeout(() => setSaved(false), 2000)
	}

	return (
		<div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h1 className="text-lg font-semibold tracking-tight">Vocabulary graph colors</h1>
					<p className="text-sm text-muted-foreground mt-1">
						Global heatmap palette — applies to all users immediately on save.
					</p>
				</div>
				<div className="flex gap-2">
					<Button variant="outline" size="sm" onClick={() => void load()}>
						Refresh
					</Button>
					<Button variant="outline" size="sm" asChild>
						<Link to="/admin">Admin home</Link>
					</Button>
				</div>
			</div>

			{languages.length > 1 && (
				<div className="flex items-center gap-3">
					<span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
						Preview language
					</span>
					<select
						value={previewLanguageId ?? ""}
						onChange={(e) => setPreviewLanguageId(e.target.value || null)}
						className="rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
					>
						{languages.map((l) => (
							<option key={l.id} value={l.id}>
								{l.name}
							</option>
						))}
					</select>
				</div>
			)}

			<VocabGraphColorsCard
				colors={draft}
				savedColors={savedColors}
				onColorsChange={setDraft}
				dark={dark}
				previewLanguageId={previewLanguageId}
			/>

			{error && (
				<p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
					{error}
				</p>
			)}

			<div className="flex items-center gap-3">
				<Button onClick={() => void save()} disabled={saving}>
					{saving ? "Saving…" : "Save colors"}
				</Button>
				{saved && (
					<span className="text-xs text-known font-medium animate-count-up">
						Saved — all users will see the new palette.
					</span>
				)}
			</div>
		</div>
	)
}
