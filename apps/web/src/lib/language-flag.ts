import { LANGUAGES } from "@nwords/shared"

/** ISO 639-1 codes that differ from a sensible ISO 3166-1 alpha-2 region for flag emoji. */
const LANG_TO_REGION_OVERRIDES: Partial<Record<string, string>> = {
	ar: "SA",
	bn: "BD",
	ca: "ES",
	zh: "CN",
	cs: "CZ",
	da: "DK",
	el: "GR",
	en: "GB",
	et: "EE",
	he: "IL",
	hi: "IN",
	ja: "JP",
	ko: "KR",
	ms: "MY",
	nb: "NO",
	fa: "IR",
	sl: "SI",
	sv: "SE",
	tl: "PH",
	uk: "UA",
	ur: "PK",
	vi: "VN",
}

function regionForLanguageCode(code: string): string | null {
	const key = code.toLowerCase()
	if (!/^[a-z]{2}$/.test(key)) return null
	const override = LANG_TO_REGION_OVERRIDES[key]
	if (override) return override
	if (LANGUAGES.some((l) => l.code === key)) return key.toUpperCase()
	return key.toUpperCase()
}

/** Regional indicator flag emoji for a language `code` (typically ISO 639-1). Fallback: globe. */
export function languageCodeToFlagEmoji(code: string): string {
	const region = regionForLanguageCode(code)
	if (!region || region.length !== 2) return "🌐"
	const codePoints = [...region].map((ch) => 127397 + ch.charCodeAt(0))
	return String.fromCodePoint(...codePoints)
}
