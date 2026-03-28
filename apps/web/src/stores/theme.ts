import { create } from "zustand"
import { persist } from "zustand/middleware"

export const UI_STYLES = ["minimal", "brutalist", "glass", "terminal", "ink"] as const
export type UiStyle = (typeof UI_STYLES)[number]

interface ThemeState {
	dark: boolean
	uiStyle: UiStyle
	toggleDark: () => void
	setUiStyle: (style: UiStyle) => void
}

export const useThemeStore = create<ThemeState>()(
	persist(
		(set) => ({
			dark: true,
			uiStyle: "minimal",
			toggleDark: () =>
				set((state) => {
					const next = !state.dark
					if (typeof document !== "undefined") {
						document.documentElement.classList.toggle("dark", next)
					}
					return { dark: next }
				}),
			setUiStyle: (uiStyle) => set({ uiStyle }),
		}),
		{
			name: "nwords-theme",
		},
	),
)
