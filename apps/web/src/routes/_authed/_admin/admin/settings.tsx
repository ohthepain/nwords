import { Link, createFileRoute } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
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
import { cn } from "~/lib/utils"

export const Route = createFileRoute("/_authed/_admin/admin/settings")({
	component: AdminSiteSettingsPage,
})

type AppSettingsResponse = {
	id: string
	showHints: boolean
	aiProvider: string | null
	aiModel: string | null
	aiApiKeySet: boolean
	updatedAt: string
}

type PosMismatchSeedResponse = {
	languageCount: number
	totalUpserted: number
	languages: Array<{
		name: string
		code: string
		upserted: number
		usedEnglishFallback: boolean
	}>
}

function AdminSiteSettingsPage() {
	const [settings, setSettings] = useState<AppSettingsResponse | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const [saveError, setSaveError] = useState<string | null>(null)
	const [posBusy, setPosBusy] = useState(false)
	const [posError, setPosError] = useState<string | null>(null)
	const [posResult, setPosResult] = useState<PosMismatchSeedResponse | null>(null)

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

	async function regeneratePosMismatchMessages() {
		setPosBusy(true)
		setPosError(null)
		setPosResult(null)
		const res = await fetch("/api/admin/settings/pos-mismatch-messages", {
			method: "POST",
			credentials: "include",
		})
		setPosBusy(false)
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string }
			setPosError(
				res.status === 403
					? "Admin access required."
					: (body.error ?? "Could not regenerate POS messages."),
			)
			return
		}
		const data = (await res.json()) as PosMismatchSeedResponse
		setPosResult(data)
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
								<span className="text-sm font-medium leading-tight block">
									Show inline blank hints
								</span>
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
					{settings && saving ? <p className="text-xs text-muted-foreground">Saving…</p> : null}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">Part-of-speech feedback</CardTitle>
					<CardDescription>
						Re-import user-facing sentences when the learner’s guess is the wrong part of speech
						(e.g. noun vs verb). Copy lives in code; this writes the latest text into the database
						for all enabled languages.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<Button
						type="button"
						variant="secondary"
						disabled={posBusy}
						onClick={() => void regeneratePosMismatchMessages()}
					>
						{posBusy ? "Regenerating…" : "Regenerate POS error messages"}
					</Button>
					{posError ? (
						<p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
							{posError}
						</p>
					) : null}
					{posResult ? (
						<div className="text-sm space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3">
							<p className="font-medium">
								{posResult.languageCount === 0
									? "No enabled languages — nothing to update."
									: `${posResult.totalUpserted} message${posResult.totalUpserted === 1 ? "" : "s"} upserted for ${posResult.languageCount} language${posResult.languageCount === 1 ? "" : "s"}.`}
							</p>
							{posResult.languages.length > 0 ? (
								<ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
									{posResult.languages.map((lang) => (
										<li key={lang.code}>
											{lang.name} ({lang.code}): {lang.upserted}
											{lang.usedEnglishFallback ? " — English fallback" : ""}
										</li>
									))}
								</ul>
							) : null}
						</div>
					) : null}
				</CardContent>
			</Card>

			<AiConfigCard settings={settings} onSaved={setSettings} />

			<Card>
				<CardHeader>
					<CardTitle className="text-base">Vocabulary graph appearance</CardTitle>
					<CardDescription>
						Heatmap colors are stored per account. Admins configure them under their own{" "}
						<Link to="/settings" className="text-foreground underline underline-offset-2">
							Settings
						</Link>{" "}
						→ “Vocabulary graph colors” (hue wheel + brightness).
					</CardDescription>
				</CardHeader>
			</Card>
		</div>
	)
}

const AI_PROVIDERS = [
	{ value: "anthropic", label: "Anthropic" },
	{ value: "openai", label: "OpenAI" },
]

function AiConfigCard({
	settings,
	onSaved,
}: { settings: AppSettingsResponse | null; onSaved: (s: AppSettingsResponse) => void }) {
	const [provider, setProvider] = useState(settings?.aiProvider ?? "")
	const [model, setModel] = useState(settings?.aiModel ?? "")
	const [apiKey, setApiKey] = useState("")
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [saved, setSaved] = useState(false)

	useEffect(() => {
		setProvider(settings?.aiProvider ?? "")
		setModel(settings?.aiModel ?? "")
	}, [settings?.aiProvider, settings?.aiModel])

	async function save() {
		setSaving(true)
		setError(null)
		setSaved(false)
		const body: Record<string, string> = {}
		if (provider) body.aiProvider = provider
		if (model) body.aiModel = model
		if (apiKey) body.aiApiKey = apiKey
		const res = await fetch("/api/admin/settings", {
			method: "PATCH",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		})
		setSaving(false)
		if (!res.ok) {
			const b = (await res.json().catch(() => ({}))) as { error?: string }
			setError(b.error ?? "Save failed.")
			return
		}
		const data = (await res.json()) as AppSettingsResponse
		onSaved(data)
		setApiKey("")
		setSaved(true)
	}

	const inputCn = cn(
		"flex w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none",
		"placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
		"dark:bg-input/30",
	)

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">AI / LLM configuration</CardTitle>
				<CardDescription>
					Configure the AI provider and model used for synonym checking and other AI-powered
					features.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="space-y-2">
					<Label htmlFor="ai-provider">Provider</Label>
					<Select value={provider} onValueChange={setProvider}>
						<SelectTrigger id="ai-provider" className="w-full max-w-xs">
							<SelectValue placeholder="Select provider" />
						</SelectTrigger>
						<SelectContent>
							{AI_PROVIDERS.map((p) => (
								<SelectItem key={p.value} value={p.value}>
									{p.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="space-y-2">
					<Label htmlFor="ai-model">Model</Label>
					<input
						id="ai-model"
						value={model}
						onChange={(e) => setModel(e.target.value)}
						placeholder="e.g. claude-sonnet-4-20250514"
						className={cn(inputCn, "max-w-xs")}
					/>
				</div>

				<div className="space-y-2">
					<Label htmlFor="ai-api-key">API key</Label>
					<input
						id="ai-api-key"
						type="password"
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
						placeholder={settings?.aiApiKeySet ? "••••••••  (key is set)" : "Enter API key"}
						className={cn(inputCn, "max-w-xs")}
					/>
					{settings?.aiApiKeySet && !apiKey && (
						<p className="text-xs text-muted-foreground">
							A key is already saved. Enter a new one to replace it.
						</p>
					)}
				</div>

				{error && (
					<p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
						{error}
					</p>
				)}
				{saved && (
					<p className="text-sm text-muted-foreground">AI settings saved.</p>
				)}

				<Button type="button" disabled={saving || !provider || !model} onClick={() => void save()}>
					{saving ? "Saving…" : "Save AI settings"}
				</Button>
			</CardContent>
		</Card>
	)
}
