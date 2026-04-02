import { auth } from "@nwords/auth/server"
import { prisma } from "@nwords/db"
import { createFileRoute } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { BookOpen, ChevronDown, ChevronUp } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "~/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { getWordSentences, type WordSentence } from "~/lib/get-word-sentences-server-fn"

// ─── Types ──────────────────────────────────────────────

type VocabWord = {
	id: string
	lemma: string
	pos: string
	definitions: string[]
	confidence: number
	timesTested: number
	timesCorrect: number
	lastTestedAt: string | null
	lastCorrect: boolean
	streak: number
}

// ─── Server Functions ───────────────────────────────────

const loadVocabPage = createServerFn({ method: "GET" }).handler(async () => {
	const request = getRequest()
	let defaultLanguageId: string | null = null
	if (request) {
		const session = await auth.api.getSession({ headers: request.headers })
		if (session?.user?.id) {
			const user = await prisma.user.findUnique({
				where: { id: session.user.id },
				select: { targetLanguageId: true },
			})
			defaultLanguageId = user?.targetLanguageId ?? null
		}
	}

	const languages = await prisma.language.findMany({
		where: { enabled: true },
		orderBy: { name: "asc" },
		select: { id: true, name: true, code: true },
	})

	return { languages, defaultLanguageId }
})

const searchVocab = createServerFn({ method: "POST" })
	.inputValidator(
		(data: {
			languageId: string
			knowledgeFilter: "all" | "known" | "unknown"
			matchMode: "all" | "exact" | "contains" | "starts_with" | "ends_with"
			query: string
			pos: string
			sortField: string
			sortDir: "asc" | "desc"
			limit: number
			offset: number
		}) => data,
	)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) return { words: [], total: 0 }
		const session = await auth.api.getSession({ headers: request.headers })
		if (!session?.user?.id) return { words: [], total: 0 }

		const { languageId, knowledgeFilter, matchMode, query, pos, sortField, sortDir, limit, offset } = data

		// Build the where clause for UserWordKnowledge
		const where: Record<string, unknown> = {
			userId: session.user.id,
			word: { languageId },
		}

		// Knowledge filter
		if (knowledgeFilter === "known") {
			where.confidence = { gte: 0.6 }
		} else if (knowledgeFilter === "unknown") {
			where.confidence = { lt: 0.6 }
		}

		// POS filter
		if (pos && pos !== "ALL") {
			where.word = { ...where.word as Record<string, unknown>, pos }
		}

		// Text search filter
		if (query.trim() && matchMode !== "all") {
			const q = query.trim().toLowerCase()
			const lemmaFilter =
				matchMode === "exact"
					? { equals: q }
					: matchMode === "starts_with"
						? { startsWith: q }
						: matchMode === "ends_with"
							? { endsWith: q }
							: { contains: q }

			where.word = {
				...where.word as Record<string, unknown>,
				lemma: { ...lemmaFilter, mode: "insensitive" },
			}
		}

		// Build orderBy
		const wordSortFields = ["lemma", "pos"]
		const knowledgeSortFields = ["confidence", "timesTested", "timesCorrect", "lastTestedAt", "streak"]

		let orderBy: Record<string, unknown>
		if (wordSortFields.includes(sortField)) {
			orderBy = { word: { [sortField]: sortDir } }
		} else if (knowledgeSortFields.includes(sortField)) {
			orderBy = { [sortField]: sortDir }
		} else {
			orderBy = { word: { lemma: "asc" } }
		}

		const [total, rows] = await Promise.all([
			prisma.userWordKnowledge.count({ where }),
			prisma.userWordKnowledge.findMany({
				where,
				orderBy,
				skip: offset,
				take: limit,
				include: {
					word: {
						select: {
							id: true,
							lemma: true,
							pos: true,
							definitions: true,
						},
					},
				},
			}),
		])

		const words: VocabWord[] = rows.map((r) => ({
			id: r.word.id,
			lemma: r.word.lemma,
			pos: r.word.pos,
			definitions: r.word.definitions as string[],
			confidence: r.confidence,
			timesTested: r.timesTested,
			timesCorrect: r.timesCorrect,
			lastTestedAt: r.lastTestedAt?.toISOString() ?? null,
			lastCorrect: r.lastCorrect,
			streak: r.streak,
		}))

		return { words, total }
	})

// ─── Route ──────────────────────────────────────────────

export const Route = createFileRoute("/_authed/vocab")({
	loader: () => loadVocabPage(),
	component: VocabPage,
})

// ─── Constants ──────────────────────────────────────────

const POS_OPTIONS = [
	"ALL",
	"NOUN",
	"VERB",
	"ADJECTIVE",
	"ADVERB",
	"PRONOUN",
	"DETERMINER",
	"PREPOSITION",
	"CONJUNCTION",
	"PARTICLE",
	"INTERJECTION",
	"NUMERAL",
	"PROPER_NOUN",
] as const

const KNOWLEDGE_OPTIONS = [
	{ value: "all", label: "All words" },
	{ value: "known", label: "Words I know" },
	{ value: "unknown", label: "Words I don't know" },
] as const

const MATCH_MODES = [
	{ value: "all", label: "All words" },
	{ value: "exact", label: "Is exactly" },
	{ value: "contains", label: "Contains" },
	{ value: "starts_with", label: "Starts with" },
	{ value: "ends_with", label: "Ends with" },
] as const

const POS_BADGE_STYLES: Record<string, string> = {
	NOUN: "bg-blue-500/15 text-blue-400",
	VERB: "bg-emerald-500/15 text-emerald-400",
	ADJECTIVE: "bg-amber-500/15 text-amber-400",
	ADVERB: "bg-purple-500/15 text-purple-400",
	PRONOUN: "bg-pink-500/15 text-pink-400",
	DETERMINER: "bg-cyan-500/15 text-cyan-400",
	PREPOSITION: "bg-orange-500/15 text-orange-400",
	CONJUNCTION: "bg-teal-500/15 text-teal-400",
	PARTICLE: "bg-rose-500/15 text-rose-400",
	INTERJECTION: "bg-yellow-500/15 text-yellow-400",
	NUMERAL: "bg-indigo-500/15 text-indigo-400",
	PROPER_NOUN: "bg-sky-500/15 text-sky-400",
}

const PAGE_SIZE = 50

type SortField = "lemma" | "pos" | "confidence" | "timesTested" | "timesCorrect" | "lastTestedAt" | "streak"

// ─── Component ──────────────────────────────────────────

function VocabPage() {
	const { languages, defaultLanguageId } = Route.useLoaderData()
	const { nativeLanguage } = Route.useRouteContext()

	const [languageId, setLanguageId] = useState(() => {
		if (defaultLanguageId && languages.some((l) => l.id === defaultLanguageId)) {
			return defaultLanguageId
		}
		return languages[0]?.id ?? ""
	})
	const [knowledgeFilter, setKnowledgeFilter] = useState<"all" | "known" | "unknown">("all")
	const [matchMode, setMatchMode] = useState<"all" | "exact" | "contains" | "starts_with" | "ends_with">("all")
	const [query, setQuery] = useState("")
	const [pos, setPos] = useState("ALL")
	const [sortField, setSortField] = useState<SortField>("confidence")
	const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")
	const [page, setPage] = useState(0)

	const [results, setResults] = useState<{ words: VocabWord[]; total: number } | null>(null)
	const [searching, setSearching] = useState(false)

	// Word detail dialog
	const [selectedWord, setSelectedWord] = useState<VocabWord | null>(null)
	const [sentences, setSentences] = useState<WordSentence[]>([])
	const [loadingSentences, setLoadingSentences] = useState(false)

	async function runSearch(pageOverride?: number) {
		if (!languageId) return
		setSearching(true)
		try {
			const res = await searchVocab({
				data: {
					languageId,
					knowledgeFilter,
					matchMode,
					query,
					pos,
					sortField,
					sortDir,
					limit: PAGE_SIZE,
					offset: (pageOverride ?? page) * PAGE_SIZE,
				},
			})
			setResults(res)
		} finally {
			setSearching(false)
		}
	}

	// Auto-search when filters change
	useEffect(() => {
		if (!languageId) {
			setResults(null)
			return
		}
		setPage(0)
		let cancelled = false
		setSearching(true)
		searchVocab({
			data: {
				languageId,
				knowledgeFilter,
				matchMode,
				query: matchMode === "all" ? "" : query,
				pos,
				sortField,
				sortDir,
				limit: PAGE_SIZE,
				offset: 0,
			},
		})
			.then((res) => {
				if (!cancelled) setResults(res)
			})
			.finally(() => {
				if (!cancelled) setSearching(false)
			})
		return () => {
			cancelled = true
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [languageId, knowledgeFilter, matchMode, pos, sortField, sortDir])

	function handleSearch(e: React.FormEvent) {
		e.preventDefault()
		setPage(0)
		void runSearch(0)
	}

	function handleSort(field: SortField) {
		if (sortField === field) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"))
		} else {
			setSortField(field)
			setSortDir(field === "lemma" ? "asc" : "desc")
		}
	}

	function handlePageChange(newPage: number) {
		setPage(newPage)
		void runSearch(newPage)
	}

	async function openWordDetail(word: VocabWord) {
		setSelectedWord(word)
		setSentences([])
		setLoadingSentences(true)
		try {
			const res = await getWordSentences({
				data: { wordId: word.id, nativeLanguageId: nativeLanguage?.id ?? null },
			})
			setSentences(res.sentences)
		} finally {
			setLoadingSentences(false)
		}
	}

	const totalPages = results ? Math.ceil(results.total / PAGE_SIZE) : 0

	function SortIcon({ field }: { field: SortField }) {
		if (sortField !== field) return null
		return sortDir === "asc" ? (
			<ChevronUp className="size-3 inline ml-0.5" />
		) : (
			<ChevronDown className="size-3 inline ml-0.5" />
		)
	}

	const selectClass =
		"flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

	return (
		<div className="p-4 sm:p-6 space-y-6 max-w-6xl mx-auto">
			{/* Filters */}
			<form onSubmit={handleSearch} className="space-y-4">
				<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
					<div className="space-y-1.5">
						<Label htmlFor="vocab-lang" className="text-xs">
							Language
						</Label>
						<select
							id="vocab-lang"
							value={languageId}
							onChange={(e) => setLanguageId(e.target.value)}
							className={selectClass}
						>
							{languages.map((l) => (
								<option key={l.id} value={l.id}>
									{l.name}
								</option>
							))}
						</select>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="vocab-knowledge" className="text-xs">
							Knowledge
						</Label>
						<select
							id="vocab-knowledge"
							value={knowledgeFilter}
							onChange={(e) => setKnowledgeFilter(e.target.value as typeof knowledgeFilter)}
							className={selectClass}
						>
							{KNOWLEDGE_OPTIONS.map((o) => (
								<option key={o.value} value={o.value}>
									{o.label}
								</option>
							))}
						</select>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="vocab-pos" className="text-xs">
							Part of speech
						</Label>
						<select
							id="vocab-pos"
							value={pos}
							onChange={(e) => setPos(e.target.value)}
							className={selectClass}
						>
							{POS_OPTIONS.map((p) => (
								<option key={p} value={p}>
									{p === "ALL" ? "All" : p.charAt(0) + p.slice(1).toLowerCase().replace("_", " ")}
								</option>
							))}
						</select>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="vocab-match" className="text-xs">
							Search mode
						</Label>
						<select
							id="vocab-match"
							value={matchMode}
							onChange={(e) => setMatchMode(e.target.value as typeof matchMode)}
							className={selectClass}
						>
							{MATCH_MODES.map((m) => (
								<option key={m.value} value={m.value}>
									{m.label}
								</option>
							))}
						</select>
					</div>
					<div className="col-span-2 space-y-1.5">
						<Label htmlFor="vocab-query" className="text-xs">
							Search
						</Label>
						<div className="flex gap-2">
							<Input
								id="vocab-query"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder={matchMode === "all" ? "Select a search mode" : "Type a word…"}
								disabled={matchMode === "all"}
								className="h-9"
							/>
							<Button
								type="submit"
								size="sm"
								className="h-9 px-4 shrink-0"
								disabled={searching || matchMode === "all"}
							>
								{searching ? "…" : "Search"}
							</Button>
						</div>
					</div>
				</div>
			</form>

			{/* Results */}
			{results !== null && (
				<div className="space-y-3">
					<p className="text-xs text-muted-foreground font-mono">
						{results.total.toLocaleString()} word{results.total !== 1 ? "s" : ""} tested
						{results.total > PAGE_SIZE && (
							<>
								{" "}— page {page + 1} of {totalPages}
							</>
						)}
					</p>

					{results.words.length === 0 ? (
						<div className="text-center py-12 text-sm text-muted-foreground">
							<BookOpen className="size-8 mx-auto mb-3 opacity-40" />
							<p>No words found matching your filters.</p>
							<p className="text-xs mt-1">Try adjusting the filters or take some tests first!</p>
						</div>
					) : (
						<>
							<div className="border border-border rounded-lg overflow-hidden">
								<div className="overflow-x-auto">
									<div className="min-w-[700px]">
										{/* Header */}
										<div className="grid grid-cols-[1fr_80px_70px_70px_70px_90px_50px_50px] gap-2 text-[10px] font-mono text-muted-foreground uppercase tracking-[0.12em] px-4 py-2.5 bg-muted/50 border-b border-border">
											<button type="button" className="text-left hover:text-foreground transition-colors" onClick={() => handleSort("lemma")}>
												Word <SortIcon field="lemma" />
											</button>
											<button type="button" className="text-left hover:text-foreground transition-colors" onClick={() => handleSort("pos")}>
												POS <SortIcon field="pos" />
											</button>
											<button type="button" className="text-right hover:text-foreground transition-colors" onClick={() => handleSort("confidence")}>
												Conf <SortIcon field="confidence" />
											</button>
											<button type="button" className="text-right hover:text-foreground transition-colors" onClick={() => handleSort("timesTested")}>
												Tested <SortIcon field="timesTested" />
											</button>
											<button type="button" className="text-right hover:text-foreground transition-colors" onClick={() => handleSort("timesCorrect")}>
												Correct <SortIcon field="timesCorrect" />
											</button>
											<button type="button" className="text-left hover:text-foreground transition-colors" onClick={() => handleSort("lastTestedAt")}>
												Last test <SortIcon field="lastTestedAt" />
											</button>
											<button type="button" className="text-right hover:text-foreground transition-colors" onClick={() => handleSort("streak")}>
												Streak <SortIcon field="streak" />
											</button>
											<span className="text-center">Last</span>
										</div>
										{/* Rows */}
										<div className="divide-y divide-border max-h-[60vh] overflow-auto">
											{results.words.map((word) => (
												<button
													type="button"
													key={word.id}
													className="group grid grid-cols-[1fr_80px_70px_70px_70px_90px_50px_50px] gap-2 items-center px-4 py-2 hover:bg-muted/30 transition-colors w-full text-left cursor-pointer"
													onClick={() => void openWordDetail(word)}
												>
													<span className="text-sm font-medium font-mono truncate group-hover:underline underline-offset-2 decoration-foreground/60">
														{word.lemma}
													</span>
													<span
														className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full w-fit ${POS_BADGE_STYLES[word.pos] ?? "bg-muted text-muted-foreground"}`}
													>
														{word.pos.toLowerCase().replace("_", " ")}
													</span>
													<span className="text-sm font-mono tabular-nums text-right">
														<ConfidenceBadge value={word.confidence} />
													</span>
													<span className="text-sm font-mono tabular-nums text-right text-muted-foreground">
														{word.timesTested}
													</span>
													<span className="text-sm font-mono tabular-nums text-right text-muted-foreground">
														{word.timesCorrect}
													</span>
													<span className="text-xs text-muted-foreground">
														{word.lastTestedAt
															? new Date(word.lastTestedAt).toLocaleDateString()
															: "—"}
													</span>
													<span className="text-sm font-mono tabular-nums text-right text-muted-foreground">
														{word.streak}
													</span>
													<span className="text-center">
														{word.timesTested > 0 ? (
															word.lastCorrect ? (
																<span className="text-emerald-400 text-xs">✓</span>
															) : (
																<span className="text-red-400 text-xs">✗</span>
															)
														) : (
															"—"
														)}
													</span>
												</button>
											))}
										</div>
									</div>
								</div>
							</div>

							{/* Pagination */}
							{totalPages > 1 && (
								<div className="flex items-center justify-center gap-2">
									<Button
										variant="outline"
										size="sm"
										disabled={page === 0 || searching}
										onClick={() => handlePageChange(page - 1)}
									>
										Previous
									</Button>
									<span className="text-sm text-muted-foreground tabular-nums">
										{page + 1} / {totalPages}
									</span>
									<Button
										variant="outline"
										size="sm"
										disabled={page >= totalPages - 1 || searching}
										onClick={() => handlePageChange(page + 1)}
									>
										Next
									</Button>
								</div>
							)}
						</>
					)}
				</div>
			)}

			{/* Word Detail Dialog */}
			<Dialog open={selectedWord !== null} onOpenChange={(open) => !open && setSelectedWord(null)}>
				<DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
					{selectedWord && (
						<>
							<DialogHeader>
								<DialogTitle className="flex items-center gap-3">
									<span className="font-mono text-xl">{selectedWord.lemma}</span>
									<span
										className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${POS_BADGE_STYLES[selectedWord.pos] ?? "bg-muted text-muted-foreground"}`}
									>
										{selectedWord.pos.toLowerCase().replace("_", " ")}
									</span>
								</DialogTitle>
								<DialogDescription>
									{Array.isArray(selectedWord.definitions) && selectedWord.definitions.length > 0
										? selectedWord.definitions.slice(0, 5).join("; ")
										: "No definitions available"}
								</DialogDescription>
							</DialogHeader>

							{/* Stats */}
							<div className="grid grid-cols-3 sm:grid-cols-6 gap-3 py-2">
								<StatCard label="Confidence" value={`${Math.round(selectedWord.confidence * 100)}%`} />
								<StatCard label="Tested" value={selectedWord.timesTested.toString()} />
								<StatCard label="Correct" value={selectedWord.timesCorrect.toString()} />
								<StatCard
									label="Accuracy"
									value={
										selectedWord.timesTested > 0
											? `${Math.round((selectedWord.timesCorrect / selectedWord.timesTested) * 100)}%`
											: "—"
									}
								/>
								<StatCard label="Streak" value={selectedWord.streak.toString()} />
								<StatCard
									label="Last correct"
									value={
										selectedWord.timesTested > 0
											? selectedWord.lastCorrect
												? "Yes"
												: "No"
											: "—"
									}
								/>
							</div>

							{/* Sentences */}
							<div className="space-y-2">
								<h3 className="text-sm font-medium">Sentences</h3>
								{loadingSentences ? (
									<p className="text-xs text-muted-foreground py-4 text-center">Loading sentences…</p>
								) : sentences.length === 0 ? (
									<p className="text-xs text-muted-foreground py-4 text-center">
										No sentences linked to this word.
									</p>
								) : (
									<div className="space-y-2 max-h-[40vh] overflow-y-auto">
										{sentences.map((s) => (
											<div
												key={s.id}
												className="rounded-md border border-border px-3 py-2 text-sm space-y-1"
											>
												<p>{s.text}</p>
												{s.translations.length > 0 && (
													<p className="text-xs text-muted-foreground italic">
														{s.translations[0]}
													</p>
												)}
											</div>
										))}
									</div>
								)}
							</div>
						</>
					)}
				</DialogContent>
			</Dialog>
		</div>
	)
}

// ─── Helpers ────────────────────────────────────────────

function ConfidenceBadge({ value }: { value: number }) {
	const pct = Math.round(value * 100)
	const color =
		pct >= 80
			? "text-emerald-400"
			: pct >= 60
				? "text-blue-400"
				: pct >= 40
					? "text-amber-400"
					: "text-red-400"
	return <span className={`${color} font-mono text-xs`}>{pct}%</span>
}

function StatCard({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-md border border-border px-2 py-1.5 text-center">
			<p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
			<p className="text-sm font-mono font-medium">{value}</p>
		</div>
	)
}
