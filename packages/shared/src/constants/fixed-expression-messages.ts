/**
 * Localized messages and rule engine for fixed-expression grammar feedback.
 *
 * Fixed expressions (e.g. "tycka om", "tänka på") are multi-word units where
 * the preposition/particle is not guessable from general grammar rules.
 * When a learner enters the wrong particle we surface a short, deterministic
 * hint — no LLM needed.
 */

// ── Message IDs ────────────────────────────────────────

export type FixedExpressionMessageId = "fixed_expression"

// ── Localized templates ────────────────────────────────

const MESSAGES: Record<string, Record<FixedExpressionMessageId, string>> = {
	en: {
		fixed_expression:
			"\u201C{expression}\u201D is a fixed expression meaning \u201C{meaning}\u201D.",
	},
	sv: {
		fixed_expression:
			"\u201C{expression}\u201D \u00E4r ett fast uttryck som betyder \u201C{meaning}\u201D.",
	},
	fr: {
		fixed_expression:
			"\u00AB\u202F{expression}\u202F\u00BB est une expression fig\u00E9e signifiant \u00AB\u202F{meaning}\u202F\u00BB.",
	},
	de: {
		fixed_expression:
			"\u201E{expression}\u201C ist ein fester Ausdruck und bedeutet \u201E{meaning}\u201C.",
	},
	es: {
		fixed_expression:
			"\u00AB{expression}\u00BB es una expresi\u00F3n fija que significa \u00AB{meaning}\u00BB.",
	},
	fi: {
		fixed_expression:
			"\u201C{expression}\u201D on vakiintunut ilmaus, joka tarkoittaa \u201C{meaning}\u201D.",
	},
}

// ── getMessage ─────────────────────────────────────────

export function getFixedExpressionMessage(
	messageId: FixedExpressionMessageId,
	lang: string,
	params?: Record<string, string>,
): string {
	const langMessages = MESSAGES[lang] ?? MESSAGES.en
	let text = langMessages[messageId] ?? MESSAGES.en[messageId]

	if (params) {
		for (const [key, value] of Object.entries(params)) {
			text = text.replaceAll(`{${key}}`, value)
		}
	}

	return text
}

// ── Rule type ──────────────────────────────────────────

export type FixedExpressionRule = {
	/** A word that must appear in the sentence for this rule to fire. */
	trigger: string
	/** The correct answer (the particle/preposition the exercise expects). */
	required: string
	/** Common wrong guesses that this rule can explain. */
	invalid: string[]
	/** Which message template to use. */
	messageId: FixedExpressionMessageId
	/** Parameters interpolated into the message. */
	params: {
		expression: string
		meaning: string
	}
}

// ── Rule engine ────────────────────────────────────────

/**
 * Check whether the user's wrong guess can be explained by a
 * fixed-expression rule.
 *
 * Returns a localized feedback string, or `null` if no rule matched.
 */
export function checkFixedExpression(
	sentence: string,
	correctWord: string,
	userGuess: string,
	rules: FixedExpressionRule[],
	userLang: string,
): string | null {
	const lowerSentence = sentence.toLowerCase()
	const lowerCorrect = correctWord.toLowerCase()
	const lowerGuess = userGuess.toLowerCase()

	for (const rule of rules) {
		if (lowerCorrect !== rule.required.toLowerCase()) continue
		if (!lowerSentence.includes(rule.trigger.toLowerCase())) continue
		if (!rule.invalid.some((inv) => inv.toLowerCase() === lowerGuess)) continue

		return getFixedExpressionMessage(rule.messageId, userLang, rule.params)
	}

	return null
}

