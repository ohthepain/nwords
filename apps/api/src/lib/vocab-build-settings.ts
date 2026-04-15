import { mergeVocabBuildSettings } from "@nwords/shared"
import { getAppSettings } from "./app-settings"

export async function resolveVocabBuildSettings() {
	const s = await getAppSettings()
	return mergeVocabBuildSettings(s.vocabBuildSettings)
}
