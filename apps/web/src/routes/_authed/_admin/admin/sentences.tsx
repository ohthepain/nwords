import { prisma } from "@nwords/db"
import { createFileRoute } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { useEffect, useState } from "react"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"

// ─── Server Functions ────────────────────────────────────

const getAdminLanguages = createServerFn({ method: "GET" }).handler(async () => {
	return prisma.language.findMany({
		orderBy: { name: "asc" },
		select: { id: true, name: true, code: true },
	})
})

const searchSentences = createServerFn({ method: "POST" })
	.inputValidator(
		(data: {
			languageId: string
			query: string
			matchMode: "starts_with" | "contains" | "ends_with"
			limit: number
		}) => data,
	)
	.handler(async ({ data }) => {
		const { languageId, query, matchMode, limit } = data

		if (!query.trim()) return { sentences: [], total: 0 }

		const q = query.trim()

		const textFilter =
			matchMode === "starts_with"
				? { startsWith: q }
				: matchMode === "ends_with"
					? { endsWith: q }
					: { contains: q }

		const where = {
			languageId,
			text: { ...textFilter, mode: "insensitive" as const },
		}

		const [sentences, total] = await Promise.all([
			prisma.sentence.findMany({
				where,
				orderBy: { createdAt: "desc" },
				take: limit,
				include: {
					language: { select: { code: true } },
					sentenceWords: {
						include: { word: { select: { lemma: true } } },
						orderBy: { position: "asc" },
						take: 10,
					},
				},
			}),
			prisma.sentence.count({ where }),
		])

		return {
			sentences: sentences.map((s) => ({
				id: s.id,
				text: s.text,
				tatoebaId: s.tatoebaId,
				hasAudio: s.hasAudio,
				isTestCandidate: s.isTestCandidate,
				testQualityScore: s.testQualityScore,
				langCode: s.language.code,
				linkedWords: s.sentenceWords.map((sw) => ({
					id: sw.id,
					lemma: sw.word.lemma,
				})),
			})),
			total,
		}
	})

// ─── Route ───────────────────────────────────────────────

function parseLanguageIdSearch(raw: Record<string, unknown>): { languageId?: string } {
	const v = raw.languageId
	if (typeof v !== "string" || !v.trim()) return {}
	return { languageId: v.trim() }
}

export const Route = createFileRoute("/_authed/_admin/admin/sentences")({
	validateSearch: parseLanguageIdSearch,
	loader: () => getAdminLanguages(),
	component: AdminSentencesPage,
})

// ─── Component ───────────────────────────────────────────

const MATCH_MODES = [
	{ value: "starts_with", label: "Starts with" },
	{ value: "contains", label: "Contains" },
	{ value: "ends_with", label: "Ends with" },
] as const

function AdminSentencesPage() {
	const { languageId: languageIdFromSearch } = Route.useSearch()
	const languages = Route.useLoaderData()

	function resolveLanguageId(searchId: string | undefined): string {
		if (searchId && languages.some((l) => l.id === searchId)) return searchId
		return languages[0]?.id ?? ""
	}

	const [languageId, setLanguageId] = useState(() => resolveLanguageId(languageIdFromSearch))

	useEffect(() => {
		if (languageIdFromSearch && languages.some((l) => l.id === languageIdFromSearch)) {
			setLanguageId(languageIdFromSearch)
		}
	}, [languageIdFromSearch, languages])
	const [query, setQuery] = useState("")
	const [matchMode, setMatchMode] = useState<"starts_with" | "contains" | "ends_with">("contains")
	const [results, setResults] = useState<Awaited<ReturnType<typeof searchSentences>> | null>(null)
	const [searching, setSearching] = useState(false)

	async function handleSearch(e: React.FormEvent) {
		e.preventDefault()
		if (!query.trim() || !languageId) return
		setSearching(true)
		try {
			const data = await searchSentences({
				data: { languageId, query, matchMode, limit: 100 },
			})
			setResults(data)
		} finally {
			setSearching(false)
		}
	}

	return (
		<div className="p-6 space-y-6">
			<p className="text-sm text-muted-foreground">Search imported sentences by pattern</p>

			{/* Search form */}
			<form onSubmit={handleSearch} className="space-y-4">
				<div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
					<div className="space-y-1.5">
						<Label htmlFor="sent-lang" className="text-xs">
							Language
						</Label>
						<select
							id="sent-lang"
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
						<Label htmlFor="sent-match" className="text-xs">
							Match
						</Label>
						<select
							id="sent-match"
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
						<Label htmlFor="sent-query" className="text-xs">
							Pattern
						</Label>
						<div className="flex gap-2">
							<Input
								id="sent-query"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="e.g. buongiorno"
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
					<p className="text-xs text-muted-foreground font-mono">
						{results.total.toLocaleString()} match{results.total !== 1 ? "es" : ""}
						{results.total > 100 && " (showing first 100)"}
					</p>

					{results.sentences.length === 0 ? (
						<div className="text-center py-12 text-sm text-muted-foreground">
							No sentences found matching "{query}"
						</div>
					) : (
						<div className="border border-border rounded-lg overflow-hidden">
							<div className="grid grid-cols-[1fr_80px_80px_1fr] gap-3 text-[10px] font-mono text-muted-foreground uppercase tracking-[0.15em] px-4 py-2.5 bg-muted/50 border-b border-border">
								<span>Text</span>
								<span>Tatoeba</span>
								<span>Quality</span>
								<span>Linked Words</span>
							</div>
							<div className="divide-y divide-border max-h-[60vh] overflow-auto">
								{results.sentences.map((sentence) => (
									<div
										key={sentence.id}
										className="grid grid-cols-[1fr_80px_80px_1fr] gap-3 items-start px-4 py-2.5 hover:bg-muted/30 transition-colors"
									>
										<div className="space-y-1">
											<HighlightedText text={sentence.text} query={query} matchMode={matchMode} />
											<div className="flex items-center gap-2">
												{sentence.isTestCandidate && (
													<span className="text-[10px] font-mono bg-known/15 text-known px-1.5 py-0.5 rounded-full">
														test
													</span>
												)}
												{sentence.hasAudio && (
													<span className="text-[10px] font-mono bg-brand/15 text-brand px-1.5 py-0.5 rounded-full">
														audio
													</span>
												)}
											</div>
										</div>
										<span className="text-xs font-mono text-muted-foreground tabular-nums">
											{sentence.tatoebaId ? (
												<a
													href={`https://tatoeba.org/en/sentences/show/${sentence.tatoebaId}`}
													target="_blank"
													rel="noreferrer"
													className="underline underline-offset-2 hover:text-foreground"
												>
													{sentence.tatoebaId}
												</a>
											) : (
												"—"
											)}
										</span>
										<span className="text-xs font-mono text-muted-foreground tabular-nums">
											{sentence.testQualityScore !== null
												? sentence.testQualityScore.toFixed(2)
												: "—"}
										</span>
										<div className="flex flex-wrap gap-1">
											{sentence.linkedWords.length > 0 ? (
												sentence.linkedWords.map((w) => (
													<span
														key={w.id}
														className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground"
													>
														{w.lemma}
													</span>
												))
											) : (
												<span className="text-xs text-muted-foreground/50">none</span>
											)}
										</div>
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	)
}

function HighlightedText({
	text,
	query,
	matchMode,
}: {
	text: string
	query: string
	matchMode: "starts_with" | "contains" | "ends_with"
}) {
	if (!query.trim()) return <span className="text-sm">{text}</span>

	const lowerText = text.toLowerCase()
	const lowerQuery = query.toLowerCase()
	const idx = lowerText.indexOf(lowerQuery)

	if (idx === -1) return <span className="text-sm">{text}</span>

	const before = text.slice(0, idx)
	const match = text.slice(idx, idx + query.length)
	const after = text.slice(idx + query.length)

	return (
		<span className="text-sm">
			{before}
			<mark className="bg-brand/25 text-foreground rounded-sm px-0.5">{match}</mark>
			{after}
		</span>
	)
}
