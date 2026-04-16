import { Button } from "~/components/ui/button"
import type { TerritoryColumnAdvancedPayload } from "~/components/vocab-graph"

type Props = {
	payload: TerritoryColumnAdvancedPayload
	busy?: boolean
	onPracticeThisColumn: () => void | Promise<void>
	onNotNow: () => void | Promise<void>
}

export function NextColumnWordsPanel({ payload, busy, onPracticeThisColumn, onNotNow }: Props) {
	return (
		<section
			className="rounded-lg border border-brand/30 bg-brand/5 p-4 space-y-3 shadow-sm"
			aria-labelledby="next-column-heading"
		>
			<div className="space-y-1">
				<h2 id="next-column-heading" className="text-sm font-semibold text-foreground">
					New territory — next column
				</h2>
				<p className="text-xs text-muted-foreground leading-relaxed">
					You opened a new column on the heatmap. Here are the words still building toward full
					confidence in that column. Optional: start a short session on just this list (same as
					Start practice from Build).
				</p>
			</div>
			<ul className="max-h-40 overflow-auto space-y-1 text-xs font-mono border border-border/60 rounded-md bg-background/80 p-2">
				{payload.words.map((w) => (
					<li key={w.wordId} className="flex justify-between gap-2 tabular-nums">
						<span className="text-muted-foreground shrink-0">#{w.rank.toLocaleString()}</span>
						<span className="truncate text-foreground">{w.lemma}</span>
					</li>
				))}
			</ul>
			<div className="flex flex-wrap gap-2">
				<Button type="button" size="sm" disabled={busy} onClick={() => void onPracticeThisColumn()}>
					{busy ? "Starting…" : "Practice these words"}
				</Button>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					disabled={busy}
					onClick={() => void onNotNow()}
				>
					Not now
				</Button>
			</div>
		</section>
	)
}
