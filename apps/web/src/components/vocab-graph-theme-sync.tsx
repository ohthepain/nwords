import { useEffect } from "react"

import { applyVocabGraphCssVars } from "~/lib/vocab-graph-appearance-css"
import {
	type VocabGraphColors,
	useVocabGraphAppearanceStore,
} from "~/stores/vocab-graph-appearance"

type PublicSettings = { vocabGraphColors: VocabGraphColors | null }

/** Keeps `--vocab-graph-*` custom properties in sync with global server-side colors. */
export function VocabGraphThemeSync() {
	const colors = useVocabGraphAppearanceStore((s) => s.colors)
	const setColors = useVocabGraphAppearanceStore((s) => s.setColors)

	useEffect(() => {
		fetch("/api/settings")
			.then((r) => r.json() as Promise<PublicSettings>)
			.then((data) => {
				if (data.vocabGraphColors) {
					setColors(data.vocabGraphColors)
				} else {
					applyVocabGraphCssVars(useVocabGraphAppearanceStore.getState().colors)
				}
			})
			.catch(() => {
				applyVocabGraphCssVars(useVocabGraphAppearanceStore.getState().colors)
			})
	}, [setColors])

	useEffect(() => {
		applyVocabGraphCssVars(colors)
	}, [colors])

	return null
}
