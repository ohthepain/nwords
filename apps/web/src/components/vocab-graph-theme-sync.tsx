import { useEffect } from "react"

import { applyVocabGraphCssVars } from "~/lib/vocab-graph-appearance-css"
import { useVocabGraphAppearanceStore } from "~/stores/vocab-graph-appearance"

/** Keeps `--vocab-graph-*` custom properties in sync with persisted settings. */
export function VocabGraphThemeSync() {
	const colors = useVocabGraphAppearanceStore((s) => s.colors)

	useEffect(() => {
		const { persist } = useVocabGraphAppearanceStore
		const apply = () => applyVocabGraphCssVars(useVocabGraphAppearanceStore.getState().colors)
		if (persist.hasHydrated()) apply()
		return persist.onFinishHydration(apply)
	}, [])

	useEffect(() => {
		applyVocabGraphCssVars(colors)
	}, [colors])

	return null
}
