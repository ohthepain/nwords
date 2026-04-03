/**
 * Dictionary lemmas (always lowercased in our DB) that are honorifics / titles and
 * should not appear in cloze or frequency-ranked vocabulary — even when Kaikki leaves
 * a non–sense-tagged gloss (e.g. Swedish "dr" for "doktor").
 */
export const ABBREV_TITLE_LEMMAS = new Set(["dr", "mr", "mrs", "ms", "mx", "jr", "sr"])
