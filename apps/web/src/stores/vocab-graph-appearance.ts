import { create } from "zustand"
import { persist } from "zustand/middleware"

export type VocabGraphHsva = { h: number; s: number; v: number; a: number }

export type VocabGraphColorKey = "before" | "after" | "conquered" | "unconquered"

export type VocabGraphColors = Record<VocabGraphColorKey, VocabGraphHsva>

/** Light / dark presets tuned to match the default oklch theme tokens. */
export const VOCAB_GRAPH_THEME_DEFAULTS: Record<"light" | "dark", VocabGraphColors> = {
	light: {
		before: { h: 344, s: 52, v: 62, a: 1 },
		after: { h: 214, s: 52, v: 50, a: 1 },
		conquered: { h: 216, s: 8, v: 94, a: 1 },
		unconquered: { h: 36, s: 2, v: 96, a: 1 },
	},
	dark: {
		before: { h: 343, s: 39, v: 78, a: 1 },
		after: { h: 211, s: 38, v: 77, a: 1 },
		conquered: { h: 220, s: 39, v: 24, a: 1 },
		unconquered: { h: 240, s: 15, v: 16, a: 1 },
	},
}

type VocabGraphAppearanceState = {
	colors: VocabGraphColors
	setHsva: (key: VocabGraphColorKey, next: VocabGraphHsva) => void
	setWheelHs: (key: VocabGraphColorKey, h: number, s: number) => void
	setBrightness: (key: VocabGraphColorKey, v: number) => void
	resetForAppearance: (appearance: "light" | "dark") => void
}

export const useVocabGraphAppearanceStore = create<VocabGraphAppearanceState>()(
	persist(
		(set, get) => ({
			colors: VOCAB_GRAPH_THEME_DEFAULTS.light,
			setHsva: (key, next) =>
				set({ colors: { ...get().colors, [key]: { ...next, a: next.a ?? 1 } } }),
			setWheelHs: (key, h, s) => {
				const cur = get().colors[key]
				set({
					colors: { ...get().colors, [key]: { h, s, v: cur.v, a: cur.a } },
				})
			},
			setBrightness: (key, v) => {
				const cur = get().colors[key]
				const clamped = Math.max(0, Math.min(100, v))
				set({
					colors: { ...get().colors, [key]: { ...cur, v: clamped } },
				})
			},
			resetForAppearance: (appearance) =>
				set({ colors: structuredClone(VOCAB_GRAPH_THEME_DEFAULTS[appearance]) }),
		}),
		{
			name: "nwords-vocab-graph-appearance",
			partialize: (s) => ({ colors: s.colors }),
		},
	),
)
