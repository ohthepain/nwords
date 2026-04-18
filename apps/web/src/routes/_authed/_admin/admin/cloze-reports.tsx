import { auth } from "@nwords/auth/server"
import { prisma } from "@nwords/db"
import { Link, createFileRoute } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { useCallback, useEffect, useState } from "react"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select"
import { WordDetailDialog } from "~/components/word-detail-dialog"
import { type WordPanelWord, getWordPanelData } from "~/lib/get-word-panel-data-server-fn"
import { type WordSentence, getWordSentences } from "~/lib/get-word-sentences-server-fn"
import { cn } from "~/lib/utils"

const loadClozeReportsPage = createServerFn({ method: "GET" }).handler(async () => {
	let defaultTargetLanguageId: string | null = null
	const request = getRequest()
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

type Lang = { id: string; name: string; code: string }

type ReportRow = {
	id: string
	createdAt: string
	updatedAt: string
	status: string
	nativeLanguage: Lang
	targetLanguage: Lang
	wordId: string
	wordLemma: string
	targetSentenceId: string | null
	hintSentenceId: string | null
	targetSentenceText: string
	promptText: string
	hintText: string
	hintSource: string
	inlineHint: string | null
	userGuess: string | null
	adminCorrectClue: string | null
	adminNote: string | null
	positionAdjust: number
	wordIsTestable: boolean
}

function parseSearch(raw: Record<string, unknown>): { languageId?: string; status?: string } {
	const languageId =
		typeof raw.languageId === "string" && raw.languageId.trim() ? raw.languageId.trim() : undefined
	const status = typeof raw.status === "string" && raw.status.trim() ? raw.status.trim() : undefined
	return { languageId, status }
}

export const Route = createFileRoute("/_authed/_admin/admin/cloze-reports")({
	validateSearch: parseSearch,
	loader: () => loadClozeReportsPage(),
	component: AdminClozeReportsPage,
})

const STATUSES = [
	{ value: "all", label: "All statuses" },
	{ value: "PENDING", label: "Pending" },
	{ value: "REMOVE_CANDIDATE", label: "Removal candidate" },
	{ value: "SENTENCE_REMOVED", label: "Sentence removed" },
	{ value: "CLUE_CORRECTED", label: "Clue corrected" },
	{ value: "DISMISSED", label: "Dismissed" },
	{ value: "GOOD_SYNONYM", label: "Resolved — good synonym" },
	{ value: "BAD_SYNONYM", label: "Resolved — bad synonym" },
	{ value: "EXCLUDED_FROM_TESTS", label: "Resolved — word excluded from tests" },
] as const

function AdminClozeReportsPage() {
	const { languageId: languageIdFromSearch, status: statusFromSearch } = Route.useSearch()
	const { languages, defaultTargetLanguageId } = Route.useLoaderData()
	const { nativeLanguage } = Route.useRouteContext()

	function resolveLanguageId(searchId: string | undefined): string {
		if (searchId && languages.some((l) => l.id === searchId)) return searchId
		if (defaultTargetLanguageId && languages.some((l) => l.id === defaultTargetLanguageId)) {
			return defaultTargetLanguageId
		}
		return languages[0]?.id ?? ""
	}

	const [targetLanguageId, setTargetLanguageId] = useState(() =>
		resolveLanguageId(languageIdFromSearch),
	)
	const [statusFilter, setStatusFilter] = useState(() => statusFromSearch ?? "PENDING")

	useEffect(() => {
		if (languageIdFromSearch && languages.some((l) => l.id === languageIdFromSearch)) {
			setTargetLanguageId(languageIdFromSearch)
		}
	}, [languageIdFromSearch, languages])

	useEffect(() => {
		if (statusFromSearch) setStatusFilter(statusFromSearch)
	}, [statusFromSearch])

	const navigate = Route.useNavigate()

	const syncSearch = useCallback(
		(next: { languageId?: string; status?: string }) => {
			void navigate({
				to: "/admin/cloze-reports",
				search: {
					languageId: next.languageId,
					status: next.status === "all" ? undefined : next.status,
				},
				replace: true,
			})
		},
		[navigate],
	)

	const [reports, setReports] = useState<ReportRow[]>([])
	const [loadState, setLoadState] = useState<"idle" | "loading" | "error">("idle")
	const [listError, setListError] = useState<string | null>(null)

	const loadReports = useCallback(async () => {
		setLoadState("loading")
		setListError(null)
		try {
			const params = new URLSearchParams()
			if (targetLanguageId) params.set("targetLanguageId", targetLanguageId)
			if (statusFilter && statusFilter !== "all") params.set("status", statusFilter)
			params.set("limit", "100")
			const res = await fetch(`/api/admin/cloze-reports?${params}`, { credentials: "include" })
			if (!res.ok) {
				const t = await res.text()
				throw new Error(t || res.statusText)
			}
			const data = (await res.json()) as { reports: ReportRow[] }
			setReports(
				data.reports.map((row) => ({
					...row,
					wordIsTestable: typeof row.wordIsTestable === "boolean" ? row.wordIsTestable : true,
				})),
			)
			setLoadState("idle")
		} catch (e) {
			setListError(e instanceof Error ? e.message : "Failed to load")
			setLoadState("error")
		}
	}, [targetLanguageId, statusFilter])

	useEffect(() => {
		if (!targetLanguageId) return
		void loadReports()
	}, [targetLanguageId, loadReports])

	async function patchReport(
		id: string,
		body: { status: string; adminCorrectClue?: string; adminNote?: string },
	) {
		const res = await fetch(`/api/admin/cloze-reports/${id}`, {
			method: "PATCH",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		})
		if (!res.ok) {
			const t = await res.text()
			throw new Error(t || res.statusText)
		}
		await loadReports()
	}

	async function deleteReport(id: string) {
		const res = await fetch(`/api/admin/cloze-reports/${id}`, {
			method: "DELETE",
			credentials: "include",
		})
		if (!res.ok) {
			const t = await res.text()
			throw new Error(t || res.statusText)
		}
		await loadReports()
	}

	const [selectedWord, setSelectedWord] = useState<WordPanelWord | null>(null)
	const [sentences, setSentences] = useState<WordSentence[]>([])
	const [loadingSentences, setLoadingSentences] = useState(false)

	async function openWordDetail(wordId: string) {
		setSentences([])
		setLoadingSentences(true)
		try {
			const panel = await getWordPanelData({ data: { wordId } })
			if (!panel) return
			setSelectedWord(panel.word)
			const res = await getWordSentences({
				data: { wordId, nativeLanguageId: nativeLanguage?.id ?? null },
			})
			setSentences(res.sentences)
		} finally {
			setLoadingSentences(false)
		}
	}

	if (!languages.length) {
		return (
			<div className="p-6 max-w-3xl mx-auto">
				<p className="text-sm text-muted-foreground">No languages in the database.</p>
				<Button type="button" variant="link" className="px-0" asChild>
					<Link to="/admin">Admin home</Link>
				</Button>
			</div>
		)
	}

	return (
		<div className="p-6 max-w-3xl mx-auto space-y-6 pb-24">
			<div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
				<div>
					<h1 className="text-lg font-semibold tracking-tight">Cloze issue reports</h1>
					<p className="text-sm text-muted-foreground">
						Review reported sentences: mark for removal or record the correct clue.
					</p>
				</div>
				<Button type="button" variant="outline" size="sm" asChild>
					<Link to="/admin">Admin home</Link>
				</Button>
			</div>

			<div className="flex flex-col gap-4 sm:flex-row sm:items-end">
				<div className="space-y-2 flex-1">
					<Label htmlFor="cr-lang">Target language (pair)</Label>
					<Select
						value={targetLanguageId}
						onValueChange={(v) => {
							setTargetLanguageId(v)
							syncSearch({ languageId: v, status: statusFilter })
						}}
					>
						<SelectTrigger id="cr-lang" className="w-full max-w-md">
							<SelectValue placeholder="Language" />
						</SelectTrigger>
						<SelectContent>
							{languages.map((l) => (
								<SelectItem key={l.id} value={l.id}>
									{l.name} ({l.code})
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="space-y-2 w-full sm:w-56">
					<Label htmlFor="cr-status">Status</Label>
					<Select
						value={statusFilter}
						onValueChange={(v) => {
							setStatusFilter(v)
							syncSearch({ languageId: targetLanguageId, status: v })
						}}
					>
						<SelectTrigger id="cr-status">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{STATUSES.map((s) => (
								<SelectItem key={s.value} value={s.value}>
									{s.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<Button type="button" variant="secondary" onClick={() => void loadReports()}>
					Refresh
				</Button>
			</div>

			{loadState === "loading" && reports.length === 0 && (
				<p className="text-sm text-muted-foreground">Loading…</p>
			)}
			{listError && <p className="text-sm text-destructive">{listError}</p>}

			<ul className="space-y-6">
				{reports.map((r) => (
					<li key={r.id}>
						<ReportCard
							report={r}
							onPatch={patchReport}
							onDelete={deleteReport}
							onRefresh={loadReports}
							onOpenWord={openWordDetail}
						/>
					</li>
				))}
			</ul>

			{!listError && loadState === "idle" && reports.length === 0 && (
				<p className="text-sm text-muted-foreground">No reports for this filter.</p>
			)}

			<WordDetailDialog
				open={selectedWord !== null}
				onOpenChange={(open) => {
					if (!open) setSelectedWord(null)
				}}
				variant="admin"
				word={selectedWord}
				sentences={sentences}
				loadingSentences={loadingSentences}
			/>
		</div>
	)
}

function ReportCard({
	report: r,
	onPatch,
	onDelete,
	onRefresh,
	onOpenWord,
}: {
	report: ReportRow
	onPatch: (
		id: string,
		body: { status: string; adminCorrectClue?: string; adminNote?: string },
	) => Promise<void>
	onDelete: (id: string) => Promise<void>
	onRefresh: () => Promise<void>
	onOpenWord: (wordId: string) => Promise<void>
}) {
	const [correctClue, setCorrectClue] = useState(r.adminCorrectClue ?? "")
	const [note, setNote] = useState(r.adminNote ?? "")
	const [guess, setGuess] = useState(r.userGuess ?? "")
	const [posAdjust, setPosAdjust] = useState(String(r.positionAdjust))
	const [posAdjustSaved, setPosAdjustSaved] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [err, setErr] = useState<string | null>(null)
	const [synonymSaved, setSynonymSaved] = useState<string | null>(null)
	const [aiVerdict, setAiVerdict] = useState<"GOOD_SYNONYM" | "BAD_SYNONYM" | "NOT_SYNONYM" | null>(
		null,
	)
	const [aiChecking, setAiChecking] = useState(false)
	const [aiError, setAiError] = useState<string | null>(null)

	useEffect(() => {
		setCorrectClue(r.adminCorrectClue ?? "")
		setNote(r.adminNote ?? "")
		setSynonymSaved(null)
		setAiVerdict(null)
		setAiError(null)
	}, [r.adminCorrectClue, r.adminNote])

	async function checkSynonymWithAi() {
		if (!guess.trim()) {
			setAiError("Enter a word first.")
			return
		}
		setAiChecking(true)
		setAiError(null)
		try {
			const saved = await saveGuessToReport()
			if (!saved) {
				setAiChecking(false)
				return
			}
			const res = await fetch(`/api/admin/cloze-reports/${r.id}/check-synonym`, {
				method: "POST",
				credentials: "include",
			})
			const payload = (await res.json().catch(() => null)) as {
				verdict?: string
				error?: string
			} | null
			if (!res.ok) throw new Error(payload?.error ?? res.statusText)
			const v = payload?.verdict as typeof aiVerdict
			if (v === "GOOD_SYNONYM" || v === "BAD_SYNONYM" || v === "NOT_SYNONYM") {
				setAiVerdict(v)
			}
		} catch (e) {
			setAiError(e instanceof Error ? e.message : "AI check failed")
		} finally {
			setAiChecking(false)
		}
	}

	async function saveGuessToReport(): Promise<boolean> {
		const trimmed = guess.trim()
		if (trimmed === (r.userGuess ?? "")) return true
		const res = await fetch(`/api/admin/cloze-reports/${r.id}`, {
			method: "PATCH",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: r.status, userGuess: trimmed }),
		})
		if (!res.ok) {
			const t = await res.text()
			setErr(t || "Failed to save guess")
			return false
		}
		return true
	}

	async function excludeLemmaFromVocabTests() {
		setErr(null)
		setBusy(true)
		try {
			const res = await fetch(`/api/admin/cloze-reports/${r.id}/exclude-from-vocab-tests`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...(note.trim() ? { adminNote: note.trim() } : {}),
				}),
			})
			const payload = (await res.json().catch(() => null)) as { error?: string } | null
			if (!res.ok) {
				throw new Error(payload?.error ?? res.statusText)
			}
			await onRefresh()
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Could not exclude word")
		} finally {
			setBusy(false)
		}
	}

	async function registerSynonym(quality: "GOOD" | "BAD") {
		setErr(null)
		setSynonymSaved(null)
		if (!guess.trim()) {
			setErr("Enter a word to register as a synonym.")
			return
		}
		setBusy(true)
		try {
			const saved = await saveGuessToReport()
			if (!saved) return
			const res = await fetch(`/api/admin/cloze-reports/${r.id}/synonym`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ quality }),
			})
			const payload = (await res.json().catch(() => null)) as {
				error?: string
				guessLemma?: string
				targetLemma?: string
				quality?: string
			} | null
			if (!res.ok) {
				throw new Error(payload?.error ?? res.statusText)
			}
			const okBody = payload as { guessLemma?: string; targetLemma?: string; quality?: string }
			if (okBody.guessLemma && okBody.targetLemma) {
				setSynonymSaved(
					`Registered ${okBody.quality ?? quality} synonym: ${okBody.guessLemma} ↔ ${okBody.targetLemma}`,
				)
			} else {
				setSynonymSaved("Synonym pair saved.")
			}
			await onRefresh()
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Could not save synonym")
		} finally {
			setBusy(false)
		}
	}

	async function go(
		status: "REMOVE_CANDIDATE" | "SENTENCE_REMOVED" | "CLUE_CORRECTED" | "DISMISSED" | "PENDING",
		opts?: { requireClue?: boolean },
	) {
		setErr(null)
		if (opts?.requireClue && !correctClue.trim()) {
			setErr("Add the correct clue text first.")
			return
		}
		setBusy(true)
		try {
			await onPatch(r.id, {
				status,
				...(correctClue.trim() ? { adminCorrectClue: correctClue.trim() } : {}),
				...(note.trim() ? { adminNote: note.trim() } : {}),
			})
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Update failed")
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="rounded-xl border border-border/80 bg-card p-4 space-y-4 shadow-xs">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="text-xs font-mono text-muted-foreground">
					{r.createdAt.slice(0, 19).replace("T", " ")} · {r.status}
				</div>
				<span className="text-xs text-muted-foreground">
					{r.nativeLanguage.code} → {r.targetLanguage.code}
				</span>
			</div>

			<div className="space-y-1">
				<p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Word</p>
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<button
						type="button"
						className="font-medium underline decoration-muted-foreground/40 hover:decoration-foreground cursor-pointer"
						onClick={() => void onOpenWord(r.wordId)}
					>
						{r.wordLemma}
					</button>
					{r.wordIsTestable === false && (
						<span className="text-xs text-muted-foreground">(not in vocabulary tests)</span>
					)}
				</div>
			</div>

			<div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
				<p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Synonym</p>
				{r.userGuess != null && r.userGuess !== "" && (
					<p className="text-sm text-muted-foreground">
						User guessed: <span className="font-medium text-foreground">{r.userGuess}</span>
					</p>
				)}
				<Input
					value={guess}
					onChange={(e) => {
						setGuess(e.target.value)
						setSynonymSaved(null)
						setAiVerdict(null)
					}}
					placeholder="Enter a word to register as synonym…"
					className="h-8 text-sm font-medium"
				/>
				<div className="flex flex-wrap gap-2 pt-1">
					{aiVerdict === null ? (
						<>
							<Button
								type="button"
								size="sm"
								variant="secondary"
								disabled={busy || aiChecking}
								onClick={() => void checkSynonymWithAi()}
							>
								{aiChecking ? "Checking…" : "Check synonym"}
							</Button>
							<Button
								type="button"
								size="sm"
								disabled={busy}
								onClick={() => void registerSynonym("GOOD")}
							>
								Good synonym
							</Button>
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() => void registerSynonym("BAD")}
							>
								Bad synonym
							</Button>
						</>
					) : aiVerdict === "NOT_SYNONYM" ? (
						<>
							<p className="text-xs text-muted-foreground self-center">AI says: not a synonym</p>
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() => void registerSynonym("BAD")}
							>
								Bad synonym
							</Button>
							<Button type="button" size="sm" variant="ghost" onClick={() => setAiVerdict(null)}>
								Reset
							</Button>
						</>
					) : (
						<>
							<Button
								type="button"
								size="sm"
								disabled={busy}
								onClick={() => void registerSynonym(aiVerdict === "GOOD_SYNONYM" ? "GOOD" : "BAD")}
							>
								{aiVerdict === "GOOD_SYNONYM" ? "Good synonym" : "Bad synonym"}
							</Button>
							<Button type="button" size="sm" variant="ghost" onClick={() => setAiVerdict(null)}>
								Reset
							</Button>
						</>
					)}
				</div>
				{aiError && <p className="text-xs text-destructive">{aiError}</p>}
				{synonymSaved && <p className="text-xs text-muted-foreground">{synonymSaved}</p>}
			</div>

			<div className="space-y-1">
				<p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
					Target sentence
				</p>
				<p className="text-sm leading-relaxed">{r.targetSentenceText}</p>
			</div>

			<div className="space-y-1">
				<p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
					Cloze prompt
				</p>
				<p className="text-sm leading-relaxed">{r.promptText}</p>
			</div>

			<div className="space-y-1 rounded-lg bg-muted/40 p-3">
				<p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
					Clue shown ({r.hintSource})
				</p>
				<p className="text-sm leading-relaxed">{r.hintText}</p>
				{r.inlineHint && (
					<p className="text-xs text-muted-foreground mt-1">Inline blank hint: {r.inlineHint}</p>
				)}
			</div>

			<div className="space-y-2">
				<Label htmlFor={`note-${r.id}`}>Admin note (optional)</Label>
				<textarea
					id={`note-${r.id}`}
					value={note}
					onChange={(e) => setNote(e.target.value)}
					rows={2}
					className={cn(
						"flex w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none",
						"placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
						"dark:bg-input/30",
					)}
				/>
			</div>

			<div className="space-y-2">
				<Label htmlFor={`clue-${r.id}`}>Correct clue (for debugging / training)</Label>
				<textarea
					id={`clue-${r.id}`}
					value={correctClue}
					onChange={(e) => setCorrectClue(e.target.value)}
					rows={2}
					placeholder="What the hint should have been…"
					className={cn(
						"flex w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none",
						"placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
						"dark:bg-input/30",
					)}
				/>
			</div>

			<div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
				<p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
					Adjust word position
				</p>
				<p className="text-xs text-muted-foreground">
					Adjust word position relative to frequency order. A value of 50 moves it about 50
					positions later. Current value is {r.positionAdjust}.
				</p>
				<div className="flex items-center gap-2">
					<Input
						type="number"
						value={posAdjust}
						onChange={(e) => {
							setPosAdjust(e.target.value)
							setPosAdjustSaved(null)
						}}
						className="h-8 w-24 text-sm"
						min={-10000}
						max={10000}
					/>
					<Button
						type="button"
						size="sm"
						variant="secondary"
						disabled={busy}
						onClick={async () => {
							const val = Number.parseInt(posAdjust, 10)
							if (Number.isNaN(val)) {
								setErr("Invalid number")
								return
							}
							setBusy(true)
							setErr(null)
							setPosAdjustSaved(null)
							try {
								const res = await fetch(`/api/admin/words/${r.wordId}/position-adjust`, {
									method: "PATCH",
									credentials: "include",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({ positionAdjust: val }),
								})
								const payload = (await res.json().catch(() => null)) as {
									effectiveRank?: number
									error?: string
								} | null
								if (!res.ok) throw new Error(payload?.error ?? res.statusText)
								setPosAdjustSaved(
									`Saved: effective rank is now ${payload?.effectiveRank ?? "updated"}`,
								)
							} catch (e) {
								setErr(e instanceof Error ? e.message : "Failed to save position adjust")
							} finally {
								setBusy(false)
							}
						}}
					>
						Apply
					</Button>
				</div>
				{posAdjustSaved && <p className="text-xs text-muted-foreground">{posAdjustSaved}</p>}
			</div>

			{err && <p className="text-sm text-destructive">{err}</p>}

			<div className="flex flex-wrap gap-2 pt-1">
				<Button
					type="button"
					size="sm"
					variant="secondary"
					disabled={busy || r.status === "EXCLUDED_FROM_TESTS"}
					title={
						r.status === "EXCLUDED_FROM_TESTS"
							? "This report is already resolved as word excluded from tests."
							: r.wordIsTestable === false
								? "Lemma is already not in test pools; still records this report as handled."
								: undefined
					}
					onClick={() => void excludeLemmaFromVocabTests()}
				>
					Remove word from tests
				</Button>
				<Button
					type="button"
					size="sm"
					variant="destructive"
					disabled={busy}
					onClick={() => void go("SENTENCE_REMOVED")}
				>
					Remove sentence
				</Button>
				<Button
					type="button"
					size="sm"
					variant="secondary"
					disabled={busy}
					onClick={() => void go("CLUE_CORRECTED", { requireClue: true })}
				>
					Save correct clue
				</Button>
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={busy}
					onClick={() => void go("DISMISSED")}
				>
					Dismiss
				</Button>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					disabled={busy}
					onClick={() => void go("PENDING")}
				>
					Reopen
				</Button>
				{r.status === "DISMISSED" && (
					<Button
						type="button"
						size="sm"
						variant="destructive"
						disabled={busy}
						onClick={async () => {
							setBusy(true)
							setErr(null)
							try {
								await onDelete(r.id)
							} catch (e) {
								setErr(e instanceof Error ? e.message : "Delete failed")
							} finally {
								setBusy(false)
							}
						}}
					>
						Delete
					</Button>
				)}
			</div>
		</div>
	)
}
