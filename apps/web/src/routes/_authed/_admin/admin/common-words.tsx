import { app } from "@nwords/api"
import { auth } from "@nwords/auth/server"
import { prisma } from "@nwords/db"
import type { CurriculumSource } from "@nwords/db"
import { Link, createFileRoute } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { ListOrdered } from "lucide-react"
import { type FormEvent, useCallback, useEffect, useState } from "react"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { forwardedAdminApiHeaders } from "~/lib/server-admin-api"

function parseLanguageIdSearch(raw: Record<string, unknown>): { languageId?: string } {
	const v = raw.languageId
	if (typeof v !== "string" || !v.trim()) return {}
	return { languageId: v.trim() }
}

const loadAdminCommonWordsPage = createServerFn({ method: "GET" }).handler(async () => {
	const request = getRequest()
	let defaultTargetLanguageId: string | null = null
	if (request) {
		const session = await auth.api.getSession({ headers: request.headers })
		if (session?.user?.id) {
			const user = await prisma.user.findUnique({
				where: { id: session.user.id },
				select: { targetLanguageId: true },
			})
			defaultTargetLanguageId = user?.targetLanguageId ?? null
		}
	}

	const languages = await prisma.language.findMany({
		orderBy: { name: "asc" },
		select: { id: true, name: true, code: true },
	})

	return { languages, defaultTargetLanguageId }
})

type LemmaRow = { id: string; lemma: string; sortOrder: number; curriculumSource: CurriculumSource }

const loadCommonLemmas = createServerFn({ method: "POST" })
	.inputValidator((data: { languageId: string }) => data)
	.handler(async ({ data }) => {
		return prisma.languageCommonLemma.findMany({
			where: { languageId: data.languageId },
			orderBy: { sortOrder: "asc" },
			select: { id: true, lemma: true, sortOrder: true, curriculumSource: true },
		})
	})

const addCommonLemmaViaApi = createServerFn({ method: "POST" })
	.inputValidator((data: { languageId: string; lemma: string }) => data)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) throw new Error("Missing request context")
		const origin = new URL(request.url).origin
		const json = JSON.stringify({ lemma: data.lemma })
		const res = await app.fetch(
			new Request(`${origin}/api/admin/languages/${data.languageId}/common-lemmas`, {
				method: "POST",
				headers: forwardedAdminApiHeaders(request, { jsonBody: json }),
				body: json,
			}),
		)
		const body = (await res.json().catch(() => ({}))) as { error?: string; id?: string }
		if (!res.ok) {
			throw new Error(body.error ?? `Add failed (${res.status})`)
		}
		return body as {
			id: string
			lemma: string
			sortOrder: number
			curriculumSource: CurriculumSource
		}
	})

const deleteCommonLemmaViaApi = createServerFn({ method: "POST" })
	.inputValidator((data: { languageId: string; rowId: string }) => data)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) throw new Error("Missing request context")
		const origin = new URL(request.url).origin
		const res = await app.fetch(
			new Request(`${origin}/api/admin/languages/${data.languageId}/common-lemmas/${data.rowId}`, {
				method: "DELETE",
				headers: forwardedAdminApiHeaders(request),
			}),
		)
		const body = (await res.json().catch(() => ({}))) as { error?: string }
		if (!res.ok) {
			throw new Error(body.error ?? `Delete failed (${res.status})`)
		}
	})

export const Route = createFileRoute("/_authed/_admin/admin/common-words")({
	validateSearch: parseLanguageIdSearch,
	loader: () => loadAdminCommonWordsPage(),
	component: AdminCommonWordsPage,
})

function AdminCommonWordsPage() {
	const { languageId: languageIdFromSearch } = Route.useSearch()
	const { languages, defaultTargetLanguageId } = Route.useLoaderData()

	function resolveLanguageId(searchId: string | undefined): string {
		if (searchId && languages.some((l) => l.id === searchId)) return searchId
		if (defaultTargetLanguageId && languages.some((l) => l.id === defaultTargetLanguageId)) {
			return defaultTargetLanguageId
		}
		return languages[0]?.id ?? ""
	}

	const [languageId, setLanguageId] = useState(() => resolveLanguageId(languageIdFromSearch))

	useEffect(() => {
		if (languageIdFromSearch && languages.some((l) => l.id === languageIdFromSearch)) {
			setLanguageId(languageIdFromSearch)
		}
	}, [languageIdFromSearch, languages])

	const [lemmas, setLemmas] = useState<LemmaRow[]>([])
	const [loadingLemmas, setLoadingLemmas] = useState(false)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [newLemma, setNewLemma] = useState("")
	const [addBusy, setAddBusy] = useState(false)
	const [addError, setAddError] = useState<string | null>(null)
	const [deletingId, setDeletingId] = useState<string | null>(null)

	const refreshLemmas = useCallback(async () => {
		if (!languageId) {
			setLemmas([])
			return
		}
		setLoadingLemmas(true)
		setLoadError(null)
		try {
			const rows = await loadCommonLemmas({ data: { languageId } })
			setLemmas(rows)
		} catch (e) {
			setLoadError(e instanceof Error ? e.message : String(e))
			setLemmas([])
		} finally {
			setLoadingLemmas(false)
		}
	}, [languageId])

	useEffect(() => {
		void refreshLemmas()
	}, [refreshLemmas])

	async function handleAdd(e: FormEvent) {
		e.preventDefault()
		if (!languageId || !newLemma.trim()) return
		setAddBusy(true)
		setAddError(null)
		try {
			const row = await addCommonLemmaViaApi({ data: { languageId, lemma: newLemma } })
			setNewLemma("")
			setLemmas((prev) =>
				[
					...prev,
					{
						id: row.id,
						lemma: row.lemma,
						sortOrder: row.sortOrder,
						curriculumSource: row.curriculumSource,
					},
				].sort((a, b) => a.sortOrder - b.sortOrder),
			)
		} catch (err) {
			setAddError(err instanceof Error ? err.message : String(err))
		} finally {
			setAddBusy(false)
		}
	}

	async function handleDelete(rowId: string) {
		if (!languageId) return
		setDeletingId(rowId)
		setLoadError(null)
		try {
			await deleteCommonLemmaViaApi({ data: { languageId, rowId } })
			setLemmas((prev) => prev.filter((r) => r.id !== rowId))
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : String(err))
		} finally {
			setDeletingId(null)
		}
	}

	const selectedLang = languages.find((l) => l.id === languageId)

	return (
		<div className="p-6 max-w-3xl mx-auto space-y-6">
			<div className="flex flex-wrap items-center gap-3">
				<ListOrdered className="size-6 text-brand shrink-0" />
				<div>
					<h1 className="text-lg font-semibold">Common words</h1>
					<p className="text-sm text-muted-foreground">
						Curated frequency seed for AI vocabulary. When this list is non-empty,{" "}
						<Link to="/admin/languages" className="underline underline-offset-2">
							LLM vocabulary
						</Link>{" "}
						uses these lemmas in order. A completed “Common words” import replaces the full list;
						you can then edit it here.
					</p>
				</div>
			</div>

			<div className="flex flex-col gap-2 max-w-md">
				<Label htmlFor="language">Language</Label>
				<select
					id="language"
					className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					value={languageId}
					onChange={(e) => setLanguageId(e.target.value)}
					disabled={languages.length === 0}
				>
					{languages.length === 0 ? (
						<option value="">No languages</option>
					) : (
						languages.map((l) => (
							<option key={l.id} value={l.id}>
								{l.name} ({l.code})
							</option>
						))
					)}
				</select>
			</div>

			{loadError ? (
				<div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
					{loadError}
				</div>
			) : null}

			{selectedLang ? (
				<p className="text-sm text-muted-foreground">
					<span className="font-mono">{selectedLang.code}</span>
					{" · "}
					{loadingLemmas ? (
						"Loading…"
					) : (
						<>
							<span className="font-mono font-medium text-foreground">{lemmas.length}</span> lemmas
						</>
					)}
				</p>
			) : null}

			<form onSubmit={handleAdd} className="flex flex-wrap items-end gap-2">
				<div className="flex flex-col gap-1 flex-1 min-w-[12rem]">
					<Label htmlFor="lemma">Add lemma</Label>
					<Input
						id="lemma"
						value={newLemma}
						onChange={(e) => setNewLemma(e.target.value)}
						placeholder="e.g. avoir"
						autoComplete="off"
						disabled={!languageId || addBusy}
					/>
				</div>
				<Button type="submit" disabled={!languageId || !newLemma.trim() || addBusy}>
					{addBusy ? "Adding…" : "Add"}
				</Button>
			</form>

			{addError ? (
				<div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
					{addError}
				</div>
			) : null}

			<div className="border border-border rounded-lg overflow-hidden">
				<div className="max-h-[min(60vh,32rem)] overflow-y-auto divide-y divide-border">
					{lemmas.length === 0 && !loadingLemmas ? (
						<div className="px-4 py-8 text-center text-sm text-muted-foreground">
							No lemmas yet. Run <span className="font-mono">Common words</span> on the Languages
							page, or add lemmas above.
						</div>
					) : (
						lemmas.map((row) => (
							<div
								key={row.id}
								className="flex items-center justify-between gap-3 px-4 py-2 hover:bg-muted/40"
							>
								<span className="text-xs font-mono text-muted-foreground tabular-nums w-8 shrink-0">
									{row.sortOrder + 1}
								</span>
								<span className="text-sm font-medium flex-1 min-w-0 truncate">{row.lemma}</span>
								<span
									className="text-[10px] font-mono text-muted-foreground shrink-0 w-16 text-right"
									title="Curriculum source for this seed row"
								>
									{row.curriculumSource === "HERMIT_DAVE" ? "hermit" : "common"}
								</span>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="text-destructive hover:text-destructive shrink-0"
									disabled={deletingId !== null}
									onClick={() => handleDelete(row.id)}
								>
									{deletingId === row.id ? "…" : "Remove"}
								</Button>
							</div>
						))
					)}
				</div>
			</div>
		</div>
	)
}
