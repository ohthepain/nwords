/** Session handoff from marketing home → `/practice` (valid pair only). */
export const PRACTICE_LANGUAGE_PAIR_STORAGE_KEY = "nwords:practiceLanguagePair"

export type StoredPracticeLanguagePair = {
	nativeLanguageId: string
	targetLanguageId: string
}

export function readStoredPracticeLanguagePair(): StoredPracticeLanguagePair | null {
	if (typeof window === "undefined") return null
	try {
		const raw = sessionStorage.getItem(PRACTICE_LANGUAGE_PAIR_STORAGE_KEY)
		if (!raw) return null
		const parsed = JSON.parse(raw) as unknown
		if (
			parsed &&
			typeof parsed === "object" &&
			"nativeLanguageId" in parsed &&
			"targetLanguageId" in parsed &&
			typeof (parsed as StoredPracticeLanguagePair).nativeLanguageId === "string" &&
			typeof (parsed as StoredPracticeLanguagePair).targetLanguageId === "string"
		) {
			const { nativeLanguageId, targetLanguageId } = parsed as StoredPracticeLanguagePair
			if (!nativeLanguageId.trim() || !targetLanguageId.trim()) return null
			return { nativeLanguageId, targetLanguageId }
		}
		return null
	} catch {
		return null
	}
}

export function writeStoredPracticeLanguagePair(pair: StoredPracticeLanguagePair): void {
	if (typeof window === "undefined") return
	try {
		sessionStorage.setItem(PRACTICE_LANGUAGE_PAIR_STORAGE_KEY, JSON.stringify(pair))
	} catch {
		/* quota / private mode */
	}
}

export function clearStoredPracticeLanguagePair(): void {
	if (typeof window === "undefined") return
	try {
		sessionStorage.removeItem(PRACTICE_LANGUAGE_PAIR_STORAGE_KEY)
	} catch {
		/* ignore */
	}
}
