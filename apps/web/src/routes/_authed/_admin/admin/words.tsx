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

const searchWords = createServerFn({ method: "POST" })
	.inputValidator(
		(data: {
			languageId: string
			query: string
			matchMode: "starts_with" | "contains" | "ends_with"
			pos?: string
			limit: number
		}) => data,
	)
	.handler(async ({ data }) => {
		const { languageId, query, matchMode, pos, limit } = data

		if (!query.trim()) return { words: [], total: 0 }

		const q = query.trim().toLowerCase()

		const lemmaFilter =
			matchMode === "starts_with"
				? { startsWith: q }
				: matchMode === "ends_with"
					? { endsWith: q }
					: { contains: q }

		const where = {
			languageId,
			lemma: { ...lemmaFilter, mode: "insensitive" as const },
			...(pos && pos !== "ALL" ? { pos: pos as "NOUN" | "VERB" | "ADJECTIVE" | "ADVERB" } : {}),
		}

		const [words, total] = await Promise.all([
			prisma.word.findMany({
				where,
				orderBy: [{ rank: "asc" }, { lemma: "asc" }],
				take: limit,
				include: { language: { select: { code: true } } },
			}),
			prisma.word.count({ where }),
		])

		return {
			words: words.map((w) => ({
				id: w.id,
				lemma: w.lemma,
				pos: w.pos,
				rank: w.rank,
				definitions: w.definitions as string[],
				cefrLevel: w.cefrLevel,
				isOffensive: w.isOffensive,
				langCode: w.language.code,
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

export const Route = createFileRoute("/_authed/_admin/admin/words")({
	validateSearch: parseLanguageIdSearch,
	loader: () => getAdminLanguages(),
	component: AdminWordsPage,
})

// ─── Component ───────────────────────────────────────────

const POS_OPTIONS = ["ALL", "NOUN", "VERB", "ADJECTIVE", "ADVERB"] as const
const MATCH_MODES = [
	{ value: "starts_with", label: "Starts with" },
	{ value: "contains", label: "Contains" },
	{ value: "ends_with", label: "Ends with" },
] as const

const POS_BADGE_STYLES: Record<string, string> = {
	NOUN: "bg-blue-500/15 text-blue-400",
	VERB: "bg-emerald-500/15 text-emerald-400",
	ADJECTIVE: "bg-amber-500/15 text-amber-400",
	ADVERB: "bg-purple-500/15 text-purple-400",
}

function AdminWordsPage() {
	const { languageId: languageIdFromSearch } = Route.useSearch()
	const languages = Route.useLoaderData()

	function resolveLanguageId(searchId: string | undefined): string {
		if (searchId && languages.some((l) => l.id === searchId)) return searchId
		return languages[0]?.id ?? ""
	}

	const [languageId, setLanguageId] = useState(() =>
		resolveLanguageId(languageIdFromSearch),
	)

	useEffect(() => {
		if (
			languageIdFromSearch &&
			languages.some((l) => l.id === languageIdFromSearch)
		) {
			setLanguageId(languageIdFromSearch)
		}
	}, [languageIdFromSearch, languages])
	const [query, setQuery] = useState("")
	const [matchMode, setMatchMode] = useState<"starts_with" | "contains" | "ends_with">("starts_with")
	const [pos, setPos] = useState("ALL")
	const [results, setResults] = useState<Awaited<ReturnType<typeof searchWords>> | null>(null)
	const [searching, setSearching] = useState(false)

	async function handleSearch(e: React.FormEvent) {
		e.preventDefault()
		if (!query.trim() || !languageId) return
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

	return (
		<div className="p-6 space-y-6">
			<p className="text-sm text-muted-foreground">
				Search imported words by pattern
			</p>

			{/* Search form */}
			<form onSubmit={handleSearch} className="space-y-4">
				<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
					<div className="space-y-1.5">
						<Label htmlFor="word-lang" className="text-xs">Language</Label>
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
						<Label htmlFor="word-match" className="text-xs">Match</Label>
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
						<Label htmlFor="word-pos" className="text-xs">Part of speech</Label>
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
						<Label htmlFor="word-query" className="text-xs">Pattern</Label>
						<div className="flex gap-2">
							<Input
								id="word-query"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="e.g. mangi"
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
							{results.total.toLocaleString()} match{results.total !== 1 ? "es" : ""}
							{results.total > 100 && " (showing first 100)"}
						</p>
					</div>

					{results.words.length === 0 ? (
						<div className="text-center py-12 text-sm text-muted-foreground">
							No words found matching "{query}"
						</div>
					) : (
						<div className="border border-border rounded-lg overflow-hidden">
							<div className="grid grid-cols-[1fr_80px_70px_70px_1fr] gap-3 text-[10px] font-mono text-muted-foreground uppercase tracking-[0.15em] px-4 py-2.5 bg-muted/50 border-b border-border">
								<span>Lemma</span>
								<span>POS</span>
								<span className="text-right">Rank</span>
								<span>CEFR</span>
								<span>Definitions</span>
							</div>
							<div className="divide-y divide-border max-h-[60vh] overflow-auto">
								{results.words.map((word) => (
									<div
										key={word.id}
										className="grid grid-cols-[1fr_80px_70px_70px_1fr] gap-3 items-center px-4 py-2 hover:bg-muted/30 transition-colors"
									>
										<span className="text-sm font-medium font-mono">{word.lemma}</span>
										<span
											className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full w-fit ${POS_BADGE_STYLES[word.pos] ?? "bg-muted text-muted-foreground"}`}
										>
											{word.pos.toLowerCase()}
										</span>
										<span className="text-sm font-mono tabular-nums text-right text-muted-foreground">
											{word.rank > 0 ? word.rank.toLocaleString() : "—"}
										</span>
										<span className="text-xs font-mono text-muted-foreground">
											{word.cefrLevel ?? "—"}
										</span>
										<span className="text-xs text-muted-foreground truncate" title={Array.isArray(word.definitions) ? word.definitions.join("; ") : ""}>
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
		</div>
	)
}
