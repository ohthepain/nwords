import type { ColorResult } from "@uiw/color-convert"
import Wheel from "@uiw/react-color-wheel"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { Label } from "~/components/ui/label"
import { VocabGraph } from "~/components/vocab-graph"
import { cn } from "~/lib/utils"
import {
	VOCAB_GRAPH_THEME_DEFAULTS,
	type VocabGraphColorKey,
	type VocabGraphColors,
	type VocabGraphHsva,
} from "~/stores/vocab-graph-appearance"

const STOP_META: { key: VocabGraphColorKey; title: string; description: string }[] = [
	{
		key: "before",
		title: "Before",
		description:
			"Low confidence end of the scale (heatmap cells trending toward \u201Cstill learning\u201D).",
	},
	{
		key: "after",
		title: "After",
		description: "High confidence end of the scale (cells trending toward \u201Cwell known\u201D).",
	},
	{
		key: "conquered",
		title: "Conquered",
		description: "Background wash for columns where every visible cell is strongly verified.",
	},
	{
		key: "unconquered",
		title: "Unconquered",
		description:
			"Open field behind the heatmap and grid gaps; untested cells blend slightly toward muted text.",
	},
]

function randomBright(onWheel: (c: ColorResult) => void, onBrightness: (v: number) => void) {
	const h = Math.random() * 360
	const s = 50 + Math.random() * 50
	const v = 75 + Math.random() * 25
	onWheel({ hsva: { h, s, v, a: 1 } } as ColorResult)
	onBrightness(v)
}

function randomDark(onWheel: (c: ColorResult) => void, onBrightness: (v: number) => void) {
	const h = Math.random() * 360
	const s = 50 + Math.random() * 50
	const v = 10 + Math.random() * 30
	onWheel({ hsva: { h, s, v, a: 1 } } as ColorResult)
	onBrightness(v)
}

function HsvaWheelBlock({
	id,
	label,
	description,
	hsva,
	onWheel,
	onBrightness,
}: {
	id: string
	label: string
	description: string
	hsva: VocabGraphHsva
	onWheel: (c: ColorResult) => void
	onBrightness: (v: number) => void
}) {
	return (
		<div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
			<div className="space-y-1">
				<p className="text-sm font-medium leading-none">{label}</p>
				<p className="text-xs text-muted-foreground leading-snug">{description}</p>
			</div>
			<div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
				<div className="shrink-0 rounded-full ring-1 ring-border/50 shadow-inner overflow-hidden">
					<Wheel width={168} height={168} color={hsva} onChange={onWheel} />
				</div>
				<div className="w-full max-w-[200px] space-y-2 sm:pt-1">
					<div className="flex items-center justify-between gap-2">
						<Label
							htmlFor={`vocab-bri-${id}`}
							className="text-xs font-mono uppercase tracking-wider text-muted-foreground"
						>
							Brightness
						</Label>
						<span className="text-xs tabular-nums text-muted-foreground">
							{Math.round(hsva.v)}%
						</span>
					</div>
					<input
						id={`vocab-bri-${id}`}
						type="range"
						min={0}
						max={100}
						value={hsva.v}
						onChange={(e) => onBrightness(Number(e.target.value))}
						className={cn(
							"h-2 w-full cursor-pointer appearance-none rounded-full bg-muted",
							"[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4",
							"[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background",
							"[&::-webkit-slider-thumb]:bg-foreground [&::-webkit-slider-thumb]:shadow-sm",
							"[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2",
							"[&::-moz-range-thumb]:border-background [&::-moz-range-thumb]:bg-foreground",
						)}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={Math.round(hsva.v)}
					/>
					<div className="flex flex-col gap-2 pt-1">
						<Button
							type="button"
							variant="outline"
							size="xs"
							className="w-full"
							onClick={() => randomBright(onWheel, onBrightness)}
						>
							Random bright
						</Button>
						<Button
							type="button"
							variant="outline"
							size="xs"
							className="w-full"
							onClick={() => randomDark(onWheel, onBrightness)}
						>
							Random dark
						</Button>
					</div>
				</div>
			</div>
		</div>
	)
}

export function VocabGraphColorsCard({
	colors,
	savedColors,
	onColorsChange,
	dark,
	previewLanguageId,
}: {
	colors: VocabGraphColors
	/** The last-saved colors — used for "Restore saved" button. */
	savedColors: VocabGraphColors
	onColorsChange: (colors: VocabGraphColors) => void
	dark: boolean
	previewLanguageId: string | null
}) {
	function setWheelHs(key: VocabGraphColorKey, h: number, s: number) {
		const cur = colors[key]
		onColorsChange({ ...colors, [key]: { h, s, v: cur.v, a: cur.a } })
	}

	function setBrightness(key: VocabGraphColorKey, v: number) {
		const cur = colors[key]
		onColorsChange({ ...colors, [key]: { ...cur, v: Math.max(0, Math.min(100, v)) } })
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Vocabulary graph colors</CardTitle>
				<CardDescription>
					Hue and saturation on the wheel; brightness is the separate slider (standard HSV value).
					Applies on the Practice page heatmap. The live preview updates as you change colors.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-8">
				<div className="w-full min-w-0 space-y-2">
					<p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
						Live preview
					</p>
					{previewLanguageId ? (
						<div className="rounded-xl border border-border/70 bg-muted/15 p-3 overflow-x-auto">
							<VocabGraph
								languageId={previewLanguageId}
								activeWordId={null}
								answerFlash={null}
								showDevGrid={false}
								pointerProbe={false}
							/>
						</div>
					) : (
						<p className="text-sm text-muted-foreground rounded-lg border border-dashed border-border/80 bg-muted/10 px-3 py-6 text-center">
							No preview available — open Practice to see colors live.
						</p>
					)}
				</div>

				<div className="space-y-6 min-w-0">
					<div className="grid gap-4 md:grid-cols-2">
						{STOP_META.map(({ key, title, description }) => (
							<HsvaWheelBlock
								key={key}
								id={key}
								label={title}
								description={description}
								hsva={colors[key]}
								onWheel={(c) => setWheelHs(key, c.hsva.h, c.hsva.s)}
								onBrightness={(v) => setBrightness(key, v)}
							/>
						))}
					</div>
					<div className="flex flex-wrap items-center gap-3">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => onColorsChange(structuredClone(savedColors))}
						>
							Restore saved
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() =>
								onColorsChange(structuredClone(VOCAB_GRAPH_THEME_DEFAULTS[dark ? "dark" : "light"]))
							}
						>
							Reset to recommended ({dark ? "dark" : "light"})
						</Button>
						<p className="text-xs text-muted-foreground">
							Defaults match the built-in theme. Switch appearance and reset again for the other
							palette.
						</p>
					</div>
				</div>
			</CardContent>
		</Card>
	)
}
