import { useSyncExternalStore } from "react"
import { create } from "zustand"
import { persist } from "zustand/middleware"

export const UI_STYLES = ["minimal", "brutalist", "glass", "terminal", "ink"] as const
export type UiStyle = (typeof UI_STYLES)[number]

export type ColorScheme = "light" | "dark" | "system"

type LegacyPersisted = { dark?: boolean; colorScheme?: ColorScheme; uiStyle?: UiStyle }

function subscribeSystemPreference(callback: () => void) {
	if (typeof window === "undefined") return () => {}
	const mq = window.matchMedia("(prefers-color-scheme: dark)")
	mq.addEventListener("change", callback)
	return () => mq.removeEventListener("change", callback)
}

function getSystemIsDark(): boolean {
	if (typeof window === "undefined") return false
	return window.matchMedia("(prefers-color-scheme: dark)").matches
}

interface ThemeState {
	colorScheme: ColorScheme
	setColorScheme: (c: ColorScheme) => void
	uiStyle: UiStyle
	setUiStyle: (style: UiStyle) => void
}

export const useThemeStore = create<ThemeState>()(
	persist(
		(set) => ({
			colorScheme: "system" as ColorScheme,
			setColorScheme: (colorScheme) => set({ colorScheme }),
			uiStyle: "minimal" as UiStyle,
			setUiStyle: (uiStyle) => {
				if (typeof document !== "undefined") {
					document.documentElement.dataset.uiStyle = uiStyle
				}
				set({ uiStyle })
			},
		}),
		{
			name: "nwords-theme",
			partialize: (s) => ({ colorScheme: s.colorScheme, uiStyle: s.uiStyle }),
			/** Maps persisted `{ dark, uiStyle }` to `colorScheme` when upgrading from the old store. */
			merge: (persisted, current) => {
				const p = (persisted || {}) as LegacyPersisted & { dark?: boolean }
				const colorScheme: ColorScheme =
					p.colorScheme ??
					(typeof p.dark === "boolean" ? (p.dark ? "dark" : "light") : "system")
				return { ...current, colorScheme, uiStyle: p.uiStyle ?? current.uiStyle }
			},
			onRehydrateStorage: () => (state) => {
				if (state && typeof document !== "undefined") {
					document.documentElement.dataset.uiStyle = state.uiStyle
				}
			},
		},
	),
)

/** Resolved dark mode: respects `colorScheme` and OS preference when `system`. */
export function useEffectiveDark(): boolean {
	const colorScheme = useThemeStore((s) => s.colorScheme)
	const systemIsDark = useSyncExternalStore(subscribeSystemPreference, getSystemIsDark, () => false)
	if (colorScheme === "dark") return true
	if (colorScheme === "light") return false
	return systemIsDark
}
