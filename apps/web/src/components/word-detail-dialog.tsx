import type { ReactNode } from "react"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog"
import type { WordPanelKnowledge, WordPanelWord } from "~/lib/get-word-panel-data-server-fn"
import type { WordSentence } from "~/lib/get-word-sentences-server-fn"

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

export type VocabWordDetail = {
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

type WordDetailDialogProps =
	| {
			open: boolean
			onOpenChange: (open: boolean) => void
			variant: "vocab"
			word: VocabWordDetail | null
			sentences: WordSentence[]
			loadingSentences: boolean
	  }
	| {
			open: boolean
			onOpenChange: (open: boolean) => void
			variant: "admin"
			word: WordPanelWord | null
			sentences: WordSentence[]
			loadingSentences: boolean
	  }
	| {
			open: boolean
			onOpenChange: (open: boolean) => void
			variant: "practice"
			word: WordPanelWord | null
			knowledge: WordPanelKnowledge | null
			sentences: WordSentence[]
			loadingSentences: boolean
	  }

export function WordDetailDialog(props: WordDetailDialogProps) {
	const { open, onOpenChange, sentences, loadingSentences } = props

	function vocabBody(word: VocabWordDetail) {
		return (
			<>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-3">
						<span className="font-mono text-xl">{word.lemma}</span>
						<span
							className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${POS_BADGE_STYLES[word.pos] ?? "bg-muted text-muted-foreground"}`}
						>
							{word.pos.toLowerCase().replace("_", " ")}
						</span>
					</DialogTitle>
					<DialogDescription>
						{Array.isArray(word.definitions) && word.definitions.length > 0
							? word.definitions.slice(0, 5).join("; ")
							: "No definitions available"}
					</DialogDescription>
				</DialogHeader>

				<div className="grid grid-cols-3 sm:grid-cols-6 gap-3 py-2">
					<StatCard label="Confidence" value={`${Math.round(word.confidence * 100)}%`} />
					<StatCard label="Tested" value={word.timesTested.toString()} />
					<StatCard label="Correct" value={word.timesCorrect.toString()} />
					<StatCard
						label="Accuracy"
						value={
							word.timesTested > 0
								? `${Math.round((word.timesCorrect / word.timesTested) * 100)}%`
								: "—"
						}
					/>
					<StatCard label="Streak" value={word.streak.toString()} />
					<StatCard
						label="Last correct"
						value={word.timesTested > 0 ? (word.lastCorrect ? "Yes" : "No") : "—"}
					/>
				</div>
			</>
		)
	}

	function adminHeaderAndStats(
		word: WordPanelWord,
		knowledge: WordPanelKnowledge | null | undefined,
	) {
		const showVocabStats = knowledge != null

		return (
			<>
				<DialogHeader>
					<DialogTitle className="flex flex-wrap items-center gap-3">
						<span className="font-mono text-xl">{word.lemma}</span>
						<span
							className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${POS_BADGE_STYLES[word.pos] ?? "bg-muted text-muted-foreground"}`}
						>
							{word.pos.toLowerCase().replace("_", " ")}
						</span>
						{word.alternatePos.length > 0 && (
							<div className="flex flex-wrap items-center gap-1.5 basis-full">
								<span className="text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
									Also
								</span>
								{word.alternatePos.map((p) => (
									<span
										key={p}
										className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ring-1 ring-border/50 ${POS_BADGE_STYLES[p] ?? "bg-muted text-muted-foreground"}`}
									>
										{p.toLowerCase().replace("_", " ")}
									</span>
								))}
							</div>
						)}
					</DialogTitle>
					<DialogDescription>
						{Array.isArray(word.definitions) && word.definitions.length > 0
							? word.definitions.slice(0, 5).join("; ")
							: "No definitions available"}
					</DialogDescription>
				</DialogHeader>

				{showVocabStats && knowledge ? (
					<div className="grid grid-cols-3 sm:grid-cols-6 gap-3 py-2">
						<StatCard label="Confidence" value={`${Math.round(knowledge.confidence * 100)}%`} />
						<StatCard label="Tested" value={knowledge.timesTested.toString()} />
						<StatCard label="Correct" value={knowledge.timesCorrect.toString()} />
						<StatCard
							label="Accuracy"
							value={
								knowledge.timesTested > 0
									? `${Math.round((knowledge.timesCorrect / knowledge.timesTested) * 100)}%`
									: "—"
							}
						/>
						<StatCard label="Streak" value={knowledge.streak.toString()} />
						<StatCard
							label="Last correct"
							value={knowledge.timesTested > 0 ? (knowledge.lastCorrect ? "Yes" : "No") : "—"}
						/>
					</div>
				) : (
					<div className="flex flex-wrap gap-3 py-2">
						<StatCard label="Rank" value={word.rank > 0 ? word.rank.toLocaleString() : "—"} />
						{word.positionAdjust !== undefined ? (
							<StatCard label="Pos. adj." value={word.positionAdjust.toLocaleString()} />
						) : null}
						{word.effectiveRank !== undefined ? (
							<StatCard
								label="Eff. rank"
								value={word.effectiveRank > 0 ? word.effectiveRank.toLocaleString() : "—"}
							/>
						) : null}
						<StatCard label="CEFR" value={word.cefrLevel ?? "—"} />
						<StatCard label="Sentences" value={word.sentenceCount.toLocaleString()} />
						<StatCard label="Language" value={word.langCode} />
						<StatCard label="Offensive" value={word.isOffensive ? "Yes" : "No"} />
					</div>
				)}
			</>
		)
	}

	let body: ReactNode = null
	if (props.variant === "vocab" && props.word) {
		body = vocabBody(props.word)
	} else if (props.variant === "admin" && props.word) {
		body = adminHeaderAndStats(props.word, undefined)
	} else if (props.variant === "practice" && props.word) {
		body = adminHeaderAndStats(props.word, props.knowledge)
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
				{body}
				{body ? (
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
										{s.translations.length > 0 ? (
											<p className="text-xs text-muted-foreground italic">{s.translations[0]}</p>
										) : null}
									</div>
								))}
							</div>
						)}
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	)
}

function StatCard({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-md border border-border px-2 py-1.5 text-center">
			<p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
			<p className="text-sm font-mono font-medium">{value}</p>
		</div>
	)
}
