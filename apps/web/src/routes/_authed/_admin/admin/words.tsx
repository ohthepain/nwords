import { auth } from "@nwords/auth/server"
import { Prisma, prisma } from "@nwords/db"
import type { CefrLevel, CurriculumSource, PartOfSpeech } from "@nwords/db"
import { cefrLevelForFrequencyRank, collectFirstNUniqueEffectiveRanks } from "@nwords/shared"
import { createFileRoute } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { useCallback, useEffect, useRef, useState } from "react"
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
			source?: "ALL" | CurriculumSource
			testability?: "all" | "testable" | "not_testable"
			limit: number
			page?: number
		}) => data,
	)
	.handler(async ({ data }) => {
		const { languageId, query, matchMode, pos, source, testability = "all" } = data
		const limit = Math.min(Math.max(Math.trunc(data.limit), 1), 500)
		const page = Math.max(Math.trunc(data.page ?? 1), 1)
		const offset = (page - 1) * limit

		const posWhere =
			pos && pos !== "ALL" ? { pos: pos as "NOUN" | "VERB" | "ADJECTIVE" | "ADVERB" } : {}
		const sourceWhere =
			source && source !== "ALL" ? { curriculumSource: source as CurriculumSource } : {}
		const testabilityWhere =
			testability === "testable"
				? { isTestable: true }
				: testability === "not_testable"
					? { isTestable: false }
					: {}

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
			curriculumSource: CurriculumSource
			definitions: unknown
			cefrLevel: CefrLevel | null
			isOffensive: boolean
			isTestable: boolean
			clozeUnusableReason: string | null
			clozeUnusableDetail: string | null
			language: { code: string }
			_count: { sentenceWords: number }
		}) {
			const defsRaw = w.definitions
			const definitions = Array.isArray(defsRaw)
				? defsRaw.filter((x): x is string => typeof x === "string")
				: []
			return {
				id: w.id,
				lemma: w.lemma,
				pos: w.pos,
				alternatePos: [...w.alternatePos],
				rank: w.rank,
				positionAdjust: w.positionAdjust,
				effectiveRank: w.effectiveRank,
				curriculumSource: w.curriculumSource,
				definitions,
				cefrLevel: w.cefrLevel ?? cefrLevelForFrequencyRank(w.effectiveRank),
				isOffensive: w.isOffensive,
				isTestable: w.isTestable,
				clozeUnusableReason: w.clozeUnusableReason,
				clozeUnusableDetail: w.clozeUnusableDetail,
				langCode: w.language.code,
				sentenceCount: w._count.sentenceWords,
			}
		}

		/** Empty pattern = browse: prefer lemmas with frequency rank so you can verify import without guessing a search. */
		if (!query.trim()) {
			const baseWhere = { languageId, ...posWhere, ...sourceWhere, ...testabilityWhere }
			const [totalWords, rankedWords] = await Promise.all([
				prisma.word.count({ where: baseWhere }),
				prisma.word.count({ where: { ...baseWhere, effectiveRank: { gt: 0 } } }),
			])

			if (rankedWords > 0) {
				const [words, rankGroups] = await Promise.all([
					collectFirstNUniqueEffectiveRanks(offset + limit, (skip, take) =>
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
					words: words.slice(offset, offset + limit).map(mapWordRow),
					total: uniqueRankSlots,
					page,
					limit,
					mode: "browse_ranked" as const,
					stats: { totalWords, rankedWords, uniqueRankSlots },
				}
			}

			const [words, total] = await Promise.all([
				prisma.word.findMany({
					where: baseWhere,
					orderBy: [{ lemma: "asc" }],
					skip: offset,
					take: limit,
					include: wordInclude,
				}),
				Promise.resolve(totalWords),
			])
			return {
				words: words.map(mapWordRow),
				total,
				page,
				limit,
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
						Prisma.sql`SELECT id FROM "word" WHERE "languageId" = ${languageId}::uuid AND id::text ILIKE ${`${q}%`} LIMIT 100`,
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
						...sourceWhere,
						...testabilityWhere,
					}
				: { languageId, ...lemmaWhere, ...posWhere, ...sourceWhere, ...testabilityWhere }

		const [rankGroups, unrankedTotal, rankedMatches] = await Promise.all([
			prisma.word.groupBy({
				by: ["effectiveRank"],
				where: { ...where, effectiveRank: { gt: 0 } },
			}),
			prisma.word.count({ where: { ...where, effectiveRank: { lte: 0 } } }),
			collectFirstNUniqueEffectiveRanks(offset + limit, (skip, take) =>
				prisma.word.findMany({
					where: { ...where, effectiveRank: { gt: 0 } },
					orderBy: [{ effectiveRank: "asc" }, { id: "asc" }],
					skip,
					take,
					include: wordInclude,
				}),
			),
		])
		const rankedTotal = rankGroups.length
		const rankedPage = rankedMatches.slice(offset, offset + limit)

		const need = limit - rankedPage.length
		const words =
			need > 0
				? [
						...rankedPage,
						...(await prisma.word.findMany({
							where: { ...where, effectiveRank: { lte: 0 } },
							orderBy: [{ lemma: "asc" }],
							skip: Math.max(offset - rankedTotal, 0),
							take: need,
							include: wordInclude,
						})),
					]
				: rankedPage

		return {
			words: words.map(mapWordRow),
			total: rankedTotal + unrankedTotal,
			page,
			limit,
			mode: "search" as const,
		}
	})

// ─── Route ───────────────────────────────────────────────

function parseAdminWordsSearch(raw: Record<string, unknown>): {
	languageId?: string
	testability?: "all" | "testable" | "not_testable"
} {
	const out: { languageId?: string; testability?: "all" | "testable" | "not_testable" } = {}
	const v = raw.languageId
	if (typeof v === "string" && v.trim()) out.languageId = v.trim()
	const t = raw.testability
	if (t === "testable" || t === "not_testable") out.testability = t
	return out
}

export const Route = createFileRoute("/_authed/_admin/admin/words")({
	validateSearch: parseAdminWordsSearch,
	loader: () => loadAdminWordsPage(),
	component: AdminWordsPage,
})

// ─── Component ───────────────────────────────────────────

const POS_OPTIONS = ["ALL", "NOUN", "VERB", "ADJECTIVE", "ADVERB"] as const
const SOURCE_OPTIONS = [
	{ value: "ALL", label: "All sources" },
	{ value: "KAIKKI", label: "Kaikki" },
	{ value: "COMMON", label: "Frequency seed (Common words list)" },
	{ value: "HERMIT_DAVE", label: "HermitDave frequency lemmas" },
	{ value: "AI_CURRICULUM", label: "AI curriculum" },
] as const
const MATCH_MODES = [
	{ value: "starts_with", label: "Starts with" },
	{ value: "contains", label: "Contains" },
	{ value: "ends_with", label: "Ends with" },
	{ value: "exact", label: "Is exactly" },
] as const

const TESTABILITY_OPTIONS = [
	{ value: "all" as const, label: "All" },
	{ value: "testable" as const, label: "Testable" },
	{ value: "not_testable" as const, label: "Not testable" },
] as const

const WORDS_PAGE_SIZE = 100

type PageItem = number | { type: "ellipsis"; key: string }

function visiblePageNumbers(page: number, totalPages: number): PageItem[] {
	const pages = new Set<number>([1, totalPages])
	for (let p = page - 2; p <= page + 2; p += 1) {
		if (p >= 1 && p <= totalPages) pages.add(p)
	}
	const sorted = [...pages].sort((a, b) => a - b)
	const out: PageItem[] = []
	for (const p of sorted) {
		const previous = out[out.length - 1]
		if (typeof previous === "number" && p - previous > 1) {
			out.push({ type: "ellipsis", key: `gap-${previous}-${p}` })
		}
		out.push(p)
	}
	return out
}

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
	curriculumSource: CurriculumSource
	definitions: string[]
	cefrLevel: string | null
	isOffensive: boolean
	isTestable: boolean
	/** Set when cloze generation marks the row non-testable with a structured reason. */
	clozeUnusableReason: string | null
	clozeUnusableDetail: string | null
	langCode: string
	sentenceCount: number
}

function AdminWordsPage() {
	const { languageId: languageIdFromSearch, testability: testabilityFromSearch } = Route.useSearch()
	const { languages, defaultTargetLanguageId } = Route.useLoaderData()
	const { nativeLanguage } = Route.useRouteContext()
	const navigate = Route.useNavigate()

	function resolveLanguageId(searchId: string | undefined): string {
		if (searchId && languages.some((l) => l.id === searchId)) return searchId
		if (defaultTargetLanguageId && languages.some((l) => l.id === defaultTargetLanguageId)) {
			return defaultTargetLanguageId
		}
		return languages[0]?.id ?? ""
	}

	const [languageId, setLanguageId] = useState(() => resolveLanguageId(languageIdFromSearch))
	const [query, setQuery] = useState("")
	const [matchMode, setMatchMode] = useState<"starts_with" | "contains" | "ends_with" | "exact">(
		"starts_with",
	)
	const [pos, setPos] = useState("ALL")
	const [source, setSource] = useState<(typeof SOURCE_OPTIONS)[number]["value"]>("ALL")
	const [testability, setTestability] = useState<"all" | "testable" | "not_testable">(
		() => testabilityFromSearch ?? "all",
	)
	const [page, setPage] = useState(1)
	const lastFilterKeyRef = useRef(`${languageId}:${pos}:${source}:${testability}`)
	const [results, setResults] = useState<Awaited<ReturnType<typeof searchWords>> | null>(null)
	const [searching, setSearching] = useState(false)
	const [searchError, setSearchError] = useState<string | null>(null)

	const [selectedWord, setSelectedWord] = useState<AdminWordRow | null>(null)
	const [sentences, setSentences] = useState<WordSentence[]>([])
	const [loadingSentences, setLoadingSentences] = useState(false)

	const [synonymIoMessage, setSynonymIoMessage] = useState<string | null>(null)
	const synonymImportInputRef = useRef<HTMLInputElement>(null)

	const [positionAdjustIoMessage, setPositionAdjustIoMessage] = useState<string | null>(null)
	const positionAdjustImportInputRef = useRef<HTMLInputElement>(null)

	const [promptWordlistMessage, setPromptWordlistMessage] = useState<string | null>(null)

	useEffect(() => {
		if (languageIdFromSearch && languages.some((l) => l.id === languageIdFromSearch)) {
			setLanguageId(languageIdFromSearch)
		}
	}, [languageIdFromSearch, languages])

	useEffect(() => {
		if (testabilityFromSearch) setTestability(testabilityFromSearch)
	}, [testabilityFromSearch])

	const syncWordsSearchToUrl = useCallback(() => {
		if (!languageId) return
		void navigate({
			to: "/admin/words",
			search: {
				languageId,
				testability: testability === "all" ? undefined : testability,
			},
			replace: true,
		})
	}, [languageId, testability, navigate])

	useEffect(() => {
		syncWordsSearchToUrl()
	}, [syncWordsSearchToUrl])

	/** Prevent Prisma UUID errors if the dropdown still holds an id removed from DB. */
	useEffect(() => {
		if (languages.length === 0) {
			if (languageId) setLanguageId("")
			return
		}
		if (languageId && languages.some((l) => l.id === languageId)) return
		const next =
			languageIdFromSearch && languages.some((l) => l.id === languageIdFromSearch)
				? languageIdFromSearch
				: defaultTargetLanguageId && languages.some((l) => l.id === defaultTargetLanguageId)
					? defaultTargetLanguageId
					: (languages[0]?.id ?? "")
		setLanguageId(next)
	}, [defaultTargetLanguageId, languageId, languageIdFromSearch, languages])

	// biome-ignore lint/correctness/useExhaustiveDependencies: reload on language/POS/page change only; query/matchMode submitted explicitly
	useEffect(() => {
		if (!languageId) {
			setResults(null)
			setSearching(false)
			return
		}
		const filterKey = `${languageId}:${pos}:${source}:${testability}`
		const filtersChanged = lastFilterKeyRef.current !== filterKey
		lastFilterKeyRef.current = filterKey
		if (filtersChanged && page !== 1) {
			setPage(1)
			return
		}
		let cancelled = false
		setSearching(true)
		setSearchError(null)
		searchWords({
			data: {
				languageId,
				query,
				matchMode,
				pos,
				source,
				testability,
				limit: WORDS_PAGE_SIZE,
				page,
			},
		})
			.then((data) => {
				if (!cancelled) setResults(data)
			})
			.catch((e: unknown) => {
				if (!cancelled) {
					setResults(null)
					setSearchError(e instanceof Error ? e.message : String(e))
				}
			})
			.finally(() => {
				if (!cancelled) setSearching(false)
			})
		return () => {
			cancelled = true
		}
	}, [languageId, pos, source, testability, page])

	async function exportSynonyms() {
		setSynonymIoMessage(null)
		try {
			const res = await fetch("/api/admin/words/synonyms/export", {
				credentials: "include",
			})
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string }
				throw new Error(body.error ?? "Export failed")
			}
			const blob = await res.blob()
			const cd = res.headers.get("Content-Disposition")
			const match = cd?.match(/filename="([^"]+)"/)
			const filename = match?.[1] ?? "nwords-synonyms.json"
			const url = URL.createObjectURL(blob)
			const a = document.createElement("a")
			a.href = url
			a.download = filename
			a.click()
			URL.revokeObjectURL(url)
		} catch (e) {
			setSynonymIoMessage(e instanceof Error ? e.message : "Export failed")
		}
	}

	async function onSynonymImportFileChange(e: React.ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0]
		e.target.value = ""
		if (!file) return
		setSynonymIoMessage(null)
		try {
			const text = await file.text()
			let json: unknown
			try {
				json = JSON.parse(text)
			} catch {
				throw new Error("File is not valid JSON")
			}
			const res = await fetch("/api/admin/words/synonyms/import", {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(json),
			})
			const body = (await res.json().catch(() => ({}))) as {
				ok?: boolean
				error?: string
				inserted?: number
				skippedUnresolved?: number
				skippedDuplicateInFile?: number
				skippedAlreadyInDb?: number
			}
			if (!res.ok) {
				throw new Error(body.error ?? "Import failed")
			}
			setSynonymIoMessage(
				`Imported ${body.inserted ?? 0} pair(s). Skipped: ${body.skippedAlreadyInDb ?? 0} already in database, ${body.skippedDuplicateInFile ?? 0} duplicate(s) in file, ${body.skippedUnresolved ?? 0} unresolved (missing language or word).`,
			)
		} catch (e) {
			setSynonymIoMessage(e instanceof Error ? e.message : "Import failed")
		}
	}

	async function exportPositionAdjustments(scope: "language" | "all") {
		setPositionAdjustIoMessage(null)
		if (scope === "language" && !languageId) {
			setPositionAdjustIoMessage("Select a language to export.")
			return
		}
		try {
			const qs = scope === "language" ? `?languageId=${encodeURIComponent(languageId)}` : ""
			const res = await fetch(`/api/admin/words/position-adjustments/export${qs}`, {
				credentials: "include",
			})
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string }
				throw new Error(body.error ?? "Export failed")
			}
			const blob = await res.blob()
			const cd = res.headers.get("Content-Disposition")
			const match = cd?.match(/filename="([^"]+)"/)
			const filename = match?.[1] ?? "nwords-position-adjustments.json"
			const url = URL.createObjectURL(blob)
			const a = document.createElement("a")
			a.href = url
			a.download = filename
			a.click()
			URL.revokeObjectURL(url)
		} catch (e) {
			setPositionAdjustIoMessage(e instanceof Error ? e.message : "Export failed")
		}
	}

	async function exportPromptWordlist() {
		setPromptWordlistMessage(null)
		if (!languageId) {
			setPromptWordlistMessage("Select a language to download.")
			return
		}
		try {
			const qs = `?languageId=${encodeURIComponent(languageId)}`
			const res = await fetch(`/api/admin/words/prompt-wordlist.json${qs}`, {
				credentials: "include",
			})
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string }
				throw new Error(body.error ?? "Download failed")
			}
			const blob = await res.blob()
			const cd = res.headers.get("Content-Disposition")
			const match = cd?.match(/filename="([^"]+)"/)
			const filename = match?.[1] ?? "nwords-prompt-wordlist.json"
			const url = URL.createObjectURL(blob)
			const a = document.createElement("a")
			a.href = url
			a.download = filename
			a.click()
			URL.revokeObjectURL(url)
		} catch (e) {
			setPromptWordlistMessage(e instanceof Error ? e.message : "Download failed")
		}
	}

	async function onPositionAdjustImportFileChange(e: React.ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0]
		e.target.value = ""
		if (!file) return
		setPositionAdjustIoMessage(null)
		try {
			const text = await file.text()
			let json: unknown
			try {
				json = JSON.parse(text)
			} catch {
				throw new Error("File is not valid JSON")
			}
			const res = await fetch("/api/admin/words/position-adjustments/import", {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(json),
			})
			const body = (await res.json().catch(() => ({}))) as {
				ok?: boolean
				error?: string
				applied?: number
				skippedUnresolved?: number
				skippedDuplicateInFile?: number
			}
			if (!res.ok) {
				throw new Error(body.error ?? "Import failed")
			}
			setPositionAdjustIoMessage(
				`Applied ${body.applied ?? 0} adjustment(s). Skipped: ${body.skippedDuplicateInFile ?? 0} duplicate row(s) in file, ${body.skippedUnresolved ?? 0} unresolved (unknown language, or lemma/POS not in database). Words omitted from the file were not changed.`,
			)
			void runWordQuery()
		} catch (e) {
			setPositionAdjustIoMessage(e instanceof Error ? e.message : "Import failed")
		}
	}

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

	async function runWordQuery(nextPage = page) {
		if (!languageId) {
			setResults(null)
			return
		}
		setSearching(true)
		setSearchError(null)
		try {
			const data = await searchWords({
				data: {
					languageId,
					query,
					matchMode,
					pos,
					source,
					testability,
					limit: WORDS_PAGE_SIZE,
					page: nextPage,
				},
			})
			setResults(data)
		} catch (e) {
			setResults(null)
			setSearchError(e instanceof Error ? e.message : String(e))
		} finally {
			setSearching(false)
		}
	}

	function handleSearch(e: React.FormEvent) {
		e.preventDefault()
		if (page === 1) {
			void runWordQuery(1)
		} else {
			setPage(1)
		}
	}

	const resultPage = results?.page ?? page
	const resultLimit = results?.limit ?? WORDS_PAGE_SIZE
	const totalPages = results ? Math.max(Math.ceil(results.total / resultLimit), 1) : 1
	const pageStart = results && results.words.length > 0 ? (resultPage - 1) * resultLimit + 1 : 0
	const pageEnd = results ? pageStart + results.words.length - 1 : 0
	const pageItems = results ? visiblePageNumbers(resultPage, totalPages) : []
	const sourceFilterLabel = SOURCE_OPTIONS.find((s) => s.value === source)?.label ?? source

	return (
		<div className="p-6 space-y-4">
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

			<div className="flex flex-wrap items-center gap-2 border border-border rounded-lg px-3 bg-muted/20">
				<strong className="text-foreground/90">Synonyms</strong>
				<p className="text-xs text-muted-foreground flex-1 min-w-48">
					Good/bad cloze synonym pairs: export as JSON (all languages), or import to merge without
					removing existing pairs.
				</p>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="shrink-0"
					onClick={() => void exportSynonyms()}
				>
					Export synonyms
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="shrink-0"
					onClick={() => synonymImportInputRef.current?.click()}
				>
					Import synonyms
				</Button>
				<input
					ref={synonymImportInputRef}
					type="file"
					accept="application/json,.json"
					className="sr-only"
					aria-hidden
					onChange={onSynonymImportFileChange}
				/>
			</div>
			{synonymIoMessage ? (
				<output className="text-xs text-muted-foreground block" aria-live="polite">
					{synonymIoMessage}
				</output>
			) : null}

			<div className="flex flex-wrap items-center gap-2 border border-border rounded-lg px-3 py-2.5 bg-muted/20">
				<p className="text-xs text-muted-foreground flex-1 min-w-48">
					<strong className="text-foreground/90">Rank adjustments</strong> (Adj column): export{" "}
					<code className="text-[10px]">positionAdjust</code> as JSON — only non-zero values. Import
					merges into the database and does not clear adjustments for words that are not in the
					file.
				</p>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="shrink-0"
					disabled={!languageId}
					onClick={() => void exportPositionAdjustments("language")}
				>
					Export this language
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="shrink-0"
					onClick={() => void exportPositionAdjustments("all")}
				>
					Export all languages
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="shrink-0"
					onClick={() => positionAdjustImportInputRef.current?.click()}
				>
					Import merge
				</Button>
				<input
					ref={positionAdjustImportInputRef}
					type="file"
					accept="application/json,.json"
					className="sr-only"
					aria-hidden
					onChange={onPositionAdjustImportFileChange}
				/>
			</div>
			{positionAdjustIoMessage ? (
				<output className="text-xs text-muted-foreground block" aria-live="polite">
					{positionAdjustIoMessage}
				</output>
			) : null}

			{/* Search form */}
			<form onSubmit={handleSearch} className="space-y-4">
				<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
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
						<Label htmlFor="word-source" className="text-xs">
							Source
						</Label>
						<select
							id="word-source"
							value={source}
							onChange={(e) =>
								setSource(e.target.value as (typeof SOURCE_OPTIONS)[number]["value"])
							}
							className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							{SOURCE_OPTIONS.map((s) => (
								<option key={s.value} value={s.value}>
									{s.label}
								</option>
							))}
						</select>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="word-testability" className="text-xs">
							Testability
						</Label>
						<select
							id="word-testability"
							value={testability}
							onChange={(e) =>
								setTestability(e.target.value as (typeof TESTABILITY_OPTIONS)[number]["value"])
							}
							className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							{TESTABILITY_OPTIONS.map((o) => (
								<option key={o.value} value={o.value}>
									{o.label}
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

			{searchError ? (
				<div
					className="text-sm text-destructive border border-destructive/35 bg-destructive/10 rounded-md px-3 py-2"
					role="alert"
				>
					{searchError}
				</div>
			) : null}

			<div className="flex flex-wrap items-center gap-2 border border-border rounded-lg px-3 py-2.5 bg-muted/20">
				<strong className="text-foreground/90">Prompt wordlist</strong>
				<p className="text-xs text-muted-foreground flex-1 min-w-48">
					First 5000 <strong className="text-foreground/90 font-medium">unique</strong> lemmas (one
					per lemma: best <code className="text-[10px]">effectiveRank</code> when split across POS
					rows) as compact JSON (<code className="text-[10px]">w</code> array). Uses the Language
					field above.
				</p>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="shrink-0"
					disabled={!languageId}
					onClick={() => void exportPromptWordlist()}
				>
					Download JSON
				</Button>
			</div>
			{promptWordlistMessage ? (
				<output className="text-xs text-muted-foreground block" aria-live="polite">
					{promptWordlistMessage}
				</output>
			) : null}

			{/* Results */}
			{results !== null && (
				<div className="space-y-3">
					<div className="flex items-center justify-between">
						<p className="text-xs text-muted-foreground font-mono">
							{results.mode === "browse_ranked" && results.stats ? (
								<>
									{results.stats.uniqueRankSlots.toLocaleString()} unique frequency ranks (
									{results.stats.rankedWords.toLocaleString()} word rows,{" "}
									{results.stats.totalWords.toLocaleString()} total{" "}
									{source === "ALL" ? "in language" : sourceFilterLabel.toLowerCase()})
									{results.total > resultLimit ? " — lowest ranks first" : ""}
								</>
							) : results.mode === "browse_unranked" && results.stats ? (
								<>
									No frequency ranks yet — {results.stats.totalWords.toLocaleString()} word row
									{results.stats.totalWords !== 1 ? "s" : ""}{" "}
									{source === "ALL" ? "in DB" : sourceFilterLabel.toLowerCase()} (alphabetical)
								</>
							) : (
								<>
									{results.total.toLocaleString()} match{results.total !== 1 ? "es" : ""}
								</>
							)}
							{results.total > 0 ? (
								<>
									{" "}
									— showing {pageStart.toLocaleString()}-{pageEnd.toLocaleString()} of{" "}
									{results.total.toLocaleString()}
								</>
							) : null}
						</p>
					</div>

					{results.words.length === 0 ? (
						<div className="text-center py-12 text-sm text-muted-foreground">
							{results.mode === "search" ? (
								<>No words found matching "{query}"</>
							) : (
								<>No words for this language and filters.</>
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
										<span className="min-w-0 flex items-center gap-2">
											<span
												className="text-sm font-medium font-mono group-hover:underline underline-offset-2 decoration-foreground/60 truncate text-left"
												title={
													word.clozeUnusableReason
														? `Cloze: ${word.clozeUnusableReason}${word.clozeUnusableDetail ? ` — ${word.clozeUnusableDetail}` : ""}`
														: undefined
												}
											>
												{word.lemma}
											</span>
											<span
												className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full shrink-0 ${
													word.curriculumSource === "AI_CURRICULUM"
														? "bg-brand/15 text-brand"
														: word.curriculumSource === "COMMON"
															? "bg-known/15 text-known"
															: word.curriculumSource === "HERMIT_DAVE"
																? "bg-orange-500/15 text-orange-400"
																: "bg-muted text-muted-foreground"
												}`}
												title={`Source: ${word.curriculumSource}`}
											>
												{word.curriculumSource === "AI_CURRICULUM"
													? "ai"
													: word.curriculumSource === "COMMON"
														? "freq"
														: word.curriculumSource === "HERMIT_DAVE"
															? "hd"
															: "kai"}
											</span>
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
					{totalPages > 1 ? (
						<nav className="flex flex-wrap items-center gap-2" aria-label="Word result pages">
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={searching || resultPage <= 1}
								onClick={() => setPage((p) => Math.max(p - 1, 1))}
							>
								Previous
							</Button>
							{pageItems.map((item) =>
								typeof item !== "number" ? (
									<span
										key={item.key}
										className="px-1 text-xs text-muted-foreground"
										aria-hidden="true"
									>
										...
									</span>
								) : (
									<Button
										key={item}
										type="button"
										variant={item === resultPage ? "default" : "outline"}
										size="sm"
										className="min-w-9"
										disabled={searching || item === resultPage}
										aria-current={item === resultPage ? "page" : undefined}
										onClick={() => setPage(item)}
									>
										{item.toLocaleString()}
									</Button>
								),
							)}
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={searching || resultPage >= totalPages}
								onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
							>
								Next
							</Button>
							<span className="text-xs text-muted-foreground font-mono">
								Page {resultPage.toLocaleString()} of {totalPages.toLocaleString()}
							</span>
						</nav>
					) : null}
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
