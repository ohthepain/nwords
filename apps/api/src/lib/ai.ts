import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"
import { getAiConfig } from "./app-settings"

export async function checkSynonymWithLlm(context: {
	wordLemma: string
	userGuess: string
	targetSentenceText: string
	promptText: string
	targetLanguageCode: string
	nativeLanguageCode: string
}) {
	const config = await getAiConfig()
	if (!config) throw new Error("AI is not configured. Set provider, model, and API key in admin settings.")

	const model = createModel(config)

	const { text } = await generateText({
		model,
		system: `You are a language expert evaluating whether a learner's guess is an acceptable synonym in a cloze (fill-in-the-blank) exercise. The target language is ${context.targetLanguageCode} and the learner's native language is ${context.nativeLanguageCode}.

Respond with EXACTLY one of these three values and nothing else:
- GOOD_SYNONYM — the guess is an acceptable substitute that preserves the meaning in this sentence
- BAD_SYNONYM — the guess is related or close but not an acceptable substitute in this context
- NOT_SYNONYM — the guess is not a synonym at all`,
		prompt: `Target word: ${context.wordLemma}
User's guess: ${context.userGuess}
Full sentence: ${context.targetSentenceText}
Cloze prompt (word blanked out): ${context.promptText}

Is "${context.userGuess}" an acceptable synonym for "${context.wordLemma}" in this sentence?`,
	})

	const verdict = text.trim().toUpperCase()
	if (verdict === "GOOD_SYNONYM" || verdict === "BAD_SYNONYM" || verdict === "NOT_SYNONYM") {
		return verdict
	}
	throw new Error(`Unexpected LLM response: ${text}`)
}

function createModel(config: { provider: string; model: string; apiKey: string }) {
	switch (config.provider) {
		case "anthropic": {
			const anthropic = createAnthropic({ apiKey: config.apiKey })
			return anthropic(config.model)
		}
		case "openai": {
			const openai = createOpenAI({ apiKey: config.apiKey })
			return openai(config.model)
		}
		default:
			throw new Error(`Unsupported AI provider: ${config.provider}`)
	}
}
