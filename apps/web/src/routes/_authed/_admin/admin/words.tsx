import { auth } from "@nwords/auth/server"
import { Prisma, prisma } from "@nwords/db"
import type { CefrLevel, PartOfSpeech } from "@nwords/db"
import { cefrLevelForFrequencyRank, collectFirstNUniqueEffectiveRanks } from "@nwords/shared"
import { createFileRoute } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { useEffect, useState } from "react"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { WordDetailDialog } from "~/components/word-detail-dialog"
import { type WordSentence, getWordSentences } from "~/lib/get-word-sentences-server-fn"

// ─── Server Functions ────────────────────────────────────

const loadAdminWordsPage = createServerFn({ method: "GET" }).handler(async () => {
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

const searchWords = createServerFn({ method: "POST" })
	.inputValidator(
		(data: {
			languageId: string
			query: string
			matchMode: "starts_with" | "contains" | "ends_with" | "exact"
			pos?: string
			limit: number
		}) => data,
	)
	.handler(async ({ data }) => {
		const { languageId, query, matchMode, pos, limit } = data

		const posWhere =
			pos && pos !== "ALL" ? { pos: pos as "NOUN" | "VERB" | "ADJECTIVE" | "ADVERB" } : {}

		const wordInclude = {
			language: { select: { code: true } },
			_count: { select: { sentenceWords: true } },
		} as const

		function mapWordRow(w: {
			id: string
			lemma: string
			pos: PartOfSpeech
			alternatePos: PartOfSpeech[]
			rank: number
			positionAdjust: number
			effectiveRank: number
			definitions: unknown
			cefrLevel: CefrLevel | null
			isOffensive: boolean
			isTestable: boolean
			language: { code: string }
			_count: { sentenceWords: number }
		}) {
			return {
				id: w.id,
				lemma: w.lemma,
				pos: w.pos,
				alternatePos: [...w.alternatePos],
				rank: w.rank,
				positionAdjust: w.positionAdjust,
				effectiveRank: w.effectiveRank,
				definitions: w.definitions as string[],
				cefrLevel: w.cefrLevel ?? cefrLevelForFrequencyRank(w.effectiveRank),
				isOffensive: w.isOffensive,
				isTestable: w.isTestable,
				langCode: w.language.code,
				sentenceCount: w._count.sentenceWords,
			}
		}

		/** Empty pattern = browse: prefer lemmas with frequency rank so you can verify import without guessing a search. */
		if (!query.trim()) {
			const baseWhere = { languageId, ...posWhere }
			const [totalWords, rankedWords] = await Promise.all([
				prisma.word.count({ where: baseWhere }),
				prisma.word.count({ where: { ...baseWhere, effectiveRank: { gt: 0 } } }),
			])

			if (rankedWords > 0) {
				const [words, rankGroups] = await Promise.all([
					collectFirstNUniqueEffectiveRanks(limit, (skip, take) =>
						prisma.word.findMany({
							where: { ...baseWhere, effectiveRank: { gt: 0 } },
							orderBy: [{ effectiveRank: "asc" }, { id: "asc" }],
							skip,
							take,
							include: wordInclude,
						}),
					),
					prisma.word.groupBy({
						by: ["effectiveRank"],
						where: { ...baseWhere, effectiveRank: { gt: 0 } },
					}),
				])
				const uniqueRankSlots = rankGroups.length
				return {
					words: words.map(mapWordRow),
					total: uniqueRankSlots,
					mode: "browse_ranked" as const,
					stats: { totalWords, rankedWords, uniqueRankSlots },
				}
			}

			const [words, total] = await Promise.all([
				prisma.word.findMany({
					where: baseWhere,
					orderBy: [{ lemma: "asc" }],
					take: limit,
					include: wordInclude,
				}),
				Promise.resolve(totalWords),
			])
			return {
				words: words.map(mapWordRow),
				total,
				mode: "browse_unranked" as const,
				stats: { totalWords, rankedWords: 0, uniqueRankSlots: 0 },
			}
		}

		const q = query.trim().toLowerCase()

		const lemmaFilter =
			matchMode === "exact"
				? { equals: q }
				: matchMode === "starts_with"
					? { startsWith: q }
					: matchMode === "ends_with"
						? { endsWith: q }
						: { contains: q }

		// id is @db.Uuid — PostgreSQL won't accept LIKE on UUID columns, so cast to text via raw SQL
		const uuidLike = /^[0-9a-f-]+$/i.test(q)
		const idMatchIds = uuidLike
			? (
					await prisma.$queryRaw<{ id: string }[]>(
						Prisma.sql`SELECT id FROM "Word" WHERE "languageId" = ${languageId}::uuid AND id::text ILIKE ${`${q}%`} LIMIT 100`,
					)
				).map((r) => r.id)
			: []

		const lemmaWhere = { lemma: { ...lemmaFilter, mode: "insensitive" as const } }
		const where =
			idMatchIds.length > 0
				? {
						languageId,
						OR: [lemmaWhere, { id: { in: idMatchIds } }],
						...posWhere,
					}
				: { languageId, ...lemmaWhere, ...posWhere }

		const [total, rankedMatches] = await Promise.all([
			prisma.word.count({ where }),
			collectFirstNUniqueEffectiveRanks(limit, (skip, take) =>
				prisma.word.findMany({
					where: { ...where, effectiveRank: { gt: 0 } },
					orderBy: [{ effectiveRank: "asc" }, { id: "asc" }],
					skip,
					take,
					include: wordInclude,
				}),
			),
		])

		const need = limit - rankedMatches.length
		const words =
			need > 0
				? [
						...rankedMatches,
						...(await prisma.word.findMany({
							where: { ...where, effectiveRank: { lte: 0 } },
							orderBy: [{ lemma: "asc" }],
							take: need,
							include: wordInclude,
						})),
					]
				: rankedMatches

		return {
			words: words.map(mapWordRow),
			total,
			mode: "search" as const,
		}
	})

// ─── Route ───────────────────────────────────────────────

function parseLanguageIdSearch(raw: Record<string, unknown>): { languageId?: string } {
	const v = raw.languageId
	if (typeof v !== "string" || !v.trim()) return {}
	return { languageId: v.trim() }
}

export const Route = createFileRoute("/_authed/_admin/admin/words")({
	validateSearch: parseLanguageIdSearch,
	loader: () => loadAdminWordsPage(),
	component: AdminWordsPage,
})

// ─── Component ───────────────────────────────────────────

const POS_OPTIONS = ["ALL", "NOUN", "VERB", "ADJECTIVE", "ADVERB"] as const
const MATCH_MODES = [
	{ value: "starts_with", label: "Starts with" },
	{ value: "contains", label: "Contains" },
	{ value: "ends_with", label: "Ends with" },
	{ value: "exact", label: "Is exactly" },
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

type AdminWordRow = {
	id: string
	lemma: string
	pos: string
	alternatePos: string[]
	rank: number
	positionAdjust: number
	effectiveRank: number
	definitions: string[]
	cefrLevel: string | null
	isOffensive: boolean
	isTestable: boolean
	langCode: string
	sentenceCount: number
}

function AdminWordsPage() {
	const { languageId: languageIdFromSearch } = Route.useSearch()
	const { languages, defaultTargetLanguageId } = Route.useLoaderData()
	const { nativeLanguage } = Route.useRouteContext()

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
	const [query, setQuery] = useState("")
	const [matchMode, setMatchMode] = useState<"starts_with" | "contains" | "ends_with" | "exact">(
		"starts_with",
	)
	const [pos, setPos] = useState("ALL")
	const [results, setResults] = useState<Awaited<ReturnType<typeof searchWords>> | null>(null)
	const [searching, setSearching] = useState(false)

	const [selectedWord, setSelectedWord] = useState<AdminWordRow | null>(null)
	const [sentences, setSentences] = useState<WordSentence[]>([])
	const [loadingSentences, setLoadingSentences] = useState(false)

	async function excludeWordFromTests(wordId: string) {
		const res = await fetch(`/api/admin/words/${wordId}/exclude-from-tests`, {
			method: "POST",
			credentials: "include",
		})
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string }
			throw new Error(body.error ?? "Failed to exclude word")
		}
		setSelectedWord((w) => (w ? { ...w, isTestable: false } : null))
	}

	async function openWordDetail(word: AdminWordRow) {
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

	async function runWordQuery() {
		if (!languageId) {
			setResults(null)
			return
		}
		setSearching(true)
		try {
			const data = await searchWords({
				data: { languageId, query, matchMode, pos, limit: 100 },
			})
			setResults(data)
		} finally {
			setSearching(false)
		}
	}

	function handleSearch(e: React.FormEvent) {
		e.preventDefault()
		void runWordQuery()
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: reload on language/POS change only; query/matchMode submitted explicitly
	useEffect(() => {
		if (!languageId) {
			setResults(null)
			setSearching(false)
			return
		}
		let cancelled = false
		setSearching(true)
		searchWords({ data: { languageId, query, matchMode, pos, limit: 100 } })
			.then((data) => {
				if (!cancelled) setResults(data)
			})
			.finally(() => {
				if (!cancelled) setSearching(false)
			})
		return () => {
			cancelled = true
		}
	}, [languageId, pos])

	return (
		<div className="p-6 space-y-6">
			<div className="text-sm text-muted-foreground space-y-1">
				<p>
					Search imported words by pattern, or submit with an empty pattern to list lemmas by
					frequency rank.
				</p>
				<p className="text-xs max-w-2xl">
					<strong className="text-foreground/90">Rank</strong> and{" "}
					<strong className="text-foreground/90">CEFR</strong> are filled when the{" "}
					<strong className="text-foreground/90">frequency-list</strong> job runs after Kaikki
					(HermitDave or BNPD). Until then ranks stay 0 and both columns show “—”. CEFR here is a
					coarse band from frequency rank, not a linguistic tagger. If frequency finished but ranks
					look empty here, use an empty pattern (or retry the frequency job so it runs after the
					dictionary is loaded).
				</p>
			</div>

			{/* Search form */}
			<form onSubmit={handleSearch} className="space-y-4">
				<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
					<div className="space-y-1.5">
						<Label htmlFor="word-lang" className="text-xs">
							Language
						</Label>
						<select
							id="word-lang"
							value={languageId}
							onChange={(e) => setLanguageId(e.target.value)}
							className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							{languages.map((l) => (
								<option key={l.id} value={l.id}>
									{l.name} ({l.code})
								</option>
							))}
						</select>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="word-match" className="text-xs">
							Match
						</Label>
						<select
							id="word-match"
							value={matchMode}
							onChange={(e) => setMatchMode(e.target.value as typeof matchMode)}
							className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							{MATCH_MODES.map((m) => (
								<option key={m.value} value={m.value}>
									{m.label}
								</option>
							))}
						</select>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="word-pos" className="text-xs">
							Part of speech
						</Label>
						<select
							id="word-pos"
							value={pos}
							onChange={(e) => setPos(e.target.value)}
							className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							{POS_OPTIONS.map((p) => (
								<option key={p} value={p}>
									{p === "ALL" ? "All" : p.charAt(0) + p.slice(1).toLowerCase()}
								</option>
							))}
						</select>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="word-query" className="text-xs">
							Pattern
						</Label>
						<div className="flex gap-2">
							<Input
								id="word-query"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Empty = browse by rank"
								className="h-9"
							/>
							<Button type="submit" size="sm" className="h-9 px-4 shrink-0" disabled={searching}>
								{searching ? "..." : "Search"}
							</Button>
						</div>
					</div>
				</div>
			</form>

			{/* Results */}
			{results !== null && (
				<div className="space-y-3">
					<div className="flex items-center justify-between">
						<p className="text-xs text-muted-foreground font-mono">
							{results.mode === "browse_ranked" && results.stats ? (
								<>
									{results.stats.uniqueRankSlots.toLocaleString()} unique frequency ranks (
									{results.stats.rankedWords.toLocaleString()} word rows,{" "}
									{results.stats.totalWords.toLocaleString()} total in language)
									{results.words.length < results.total ? " — showing lowest ranks first" : ""}
									{results.words.length >= 100 ? " (first 100 ranks)" : ""}
								</>
							) : results.mode === "browse_unranked" && results.stats ? (
								<>
									No frequency ranks yet — {results.stats.totalWords.toLocaleString()} word row
									{results.stats.totalWords !== 1 ? "s" : ""} in DB (alphabetical sample)
									{results.stats.totalWords > 100 ? " (first 100)" : ""}
								</>
							) : (
								<>
									{results.total.toLocaleString()} match{results.total !== 1 ? "es" : ""}
									{results.total > 100 && " (showing first 100)"}
								</>
							)}
						</p>
					</div>

					{results.words.length === 0 ? (
						<div className="text-center py-12 text-sm text-muted-foreground">
							{results.mode === "search" ? (
								<>No words found matching "{query}"</>
							) : (
								<>No words for this language and POS filter.</>
							)}
						</div>
					) : (
						<div className="border border-border rounded-lg overflow-hidden">
							<div className="grid grid-cols-[1fr_1fr_80px_56px_56px_56px_52px_52px_1fr] gap-2 sm:gap-3 text-[10px] font-mono text-muted-foreground uppercase tracking-[0.15em] px-4 py-2.5 bg-muted/50 border-b border-border">
								<span title="Word ID (UUID)">ID</span>
								<span>Lemma</span>
								<span>POS</span>
								<span className="text-right" title="Frequency-list rank (raw)">
									Rank
								</span>
								<span className="text-right" title="positionAdjust (admin offset added to rank)">
									Adj
								</span>
								<span
									className="text-right"
									title="effectiveRank = rank + positionAdjust (used for ordering)"
								>
									Eff
								</span>
								<span>CEFR</span>
								<span className="text-right" title="Sentences linked via sentence_word">
									Sents
								</span>
								<span>Definitions</span>
							</div>
							<div className="divide-y divide-border max-h-[60vh] overflow-auto">
								{results.words.map((word) => (
									<div
										key={word.id}
										className="group grid grid-cols-[1fr_1fr_80px_56px_56px_56px_52px_52px_1fr] gap-2 sm:gap-3 items-center px-4 py-2 hover:bg-muted/30 transition-colors w-full text-left cursor-pointer"
										// biome-ignore lint/a11y/useSemanticElements: grid layout requires div
										role="button"
										tabIndex={0}
										onClick={() => void openWordDetail(word)}
										onKeyDown={(e) =>
											(e.key === "Enter" || e.key === " ") && void openWordDetail(word)
										}
									>
										<span className="text-[10px] font-mono text-muted-foreground/60 break-all">
											{word.id}
										</span>
										<span className="text-sm font-medium font-mono group-hover:underline underline-offset-2 decoration-foreground/60 truncate text-left">
											{word.lemma}
										</span>
										<span
											className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full w-fit ${POS_BADGE_STYLES[word.pos] ?? "bg-muted text-muted-foreground"}`}
										>
											{word.pos.toLowerCase()}
										</span>
										<span className="text-sm font-mono tabular-nums text-right text-muted-foreground">
											{word.rank > 0 ? word.rank.toLocaleString() : "—"}
										</span>
										<span
											className="text-sm font-mono tabular-nums text-right text-muted-foreground"
											title="positionAdjust"
										>
											{word.positionAdjust.toLocaleString()}
										</span>
										<span
											className="text-sm font-mono tabular-nums text-right text-muted-foreground"
											title="effectiveRank"
										>
											{word.effectiveRank > 0 ? word.effectiveRank.toLocaleString() : "—"}
										</span>
										<span
											className="text-xs font-mono text-muted-foreground"
											title={
												word.effectiveRank > 0
													? "Stored on word or inferred from effective rank"
													: "Run frequency import so words get rank > 0"
											}
										>
											{word.cefrLevel ?? "—"}
										</span>
										<span
											className="text-sm font-mono tabular-nums text-right text-muted-foreground"
											title="Distinct sentences this word is linked to"
										>
											{word.sentenceCount.toLocaleString()}
										</span>
										<span
											className="text-xs text-muted-foreground truncate"
											title={Array.isArray(word.definitions) ? word.definitions.join("; ") : ""}
										>
											{Array.isArray(word.definitions)
												? word.definitions.slice(0, 3).join("; ")
												: "—"}
										</span>
									</div>
								))}
							</div>
						</div>
					)}
				</div>
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
				onExcludeFromTests={selectedWord ? () => excludeWordFromTests(selectedWord.id) : undefined}
				onUpdateClozeQuality={async (sentenceId, delta) => {
					await fetch(`/api/admin/sentences/${sentenceId}/cloze-quality`, {
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						credentials: "include",
						body: JSON.stringify({ delta }),
					})
				}}
			/>
		</div>
	)
}
