import { colord } from "colord"
import type { CSSProperties } from "react"

import type { VocabGraphColors, VocabGraphHsva } from "~/stores/vocab-graph-appearance"

function hsvaToHex(h: VocabGraphHsva): string {
	return colord({ h: h.h, s: h.s, v: h.v }).toHex()
}

/** Resolve any CSS `color` value (including `var(...)`) to something colord can read. */
function readResolvedCssColor(varName: string): string {
	if (typeof document === "undefined") return "#737373"
	const el = document.createElement("span")
	el.style.color = `var(${varName})`
	el.style.position = "absolute"
	el.style.visibility = "hidden"
	el.style.pointerEvents = "none"
	document.body.appendChild(el)
	const rgb = getComputedStyle(el).color
	document.body.removeChild(el)
	return rgb || "#737373"
}

/** Same values as `applyVocabGraphCssVars`, for scoping to a subtree (e.g. admin color preview). */
export function vocabGraphColorsToStyle(colors: VocabGraphColors): CSSProperties {
	const muted = colord(readResolvedCssColor("--color-muted-foreground")).toRgb()
	const open = colord(hsvaToHex(colors.unconquered)).toRgb()
	const t = 0.28
	const untested = colord({
		r: Math.round(open.r * (1 - t) + muted.r * t),
		g: Math.round(open.g * (1 - t) + muted.g * t),
		b: Math.round(open.b * (1 - t) + muted.b * t),
	}).toHex()
	return {
		"--vocab-graph-confidence-low": hsvaToHex(colors.before),
		"--vocab-graph-confidence-high": hsvaToHex(colors.after),
		"--vocab-graph-territory-conquered": hsvaToHex(colors.conquered),
		"--vocab-graph-territory-open": hsvaToHex(colors.unconquered),
		"--vocab-graph-untested": untested,
	} as CSSProperties
}

export function applyVocabGraphCssVars(colors: VocabGraphColors): void {
	if (typeof document === "undefined") return
	const root = document.documentElement
	const style = vocabGraphColorsToStyle(colors)
	for (const [k, v] of Object.entries(style)) {
		if (typeof v === "string") root.style.setProperty(k, v)
	}
}
