# New Vocabulary Pipeline

we are going to get rid of tatoeba sentences and reset the word and sentence lists. the db is huge, the jobs take 13 hours for one language, and the app performance is compromized. so to start, let's generate a new vocabulary pipeline

The goals are better performance, more natural spoken language, faster jobs, smaller db, better localization, less manual handling of synonyms and weird sentences.

We will separate spoken and learned languages.

All jobs should be re-runnable. All output should be visible in an admin panel. This will help us iterate.

# Jobs

Common words - We will start with a job that generates a list of the 200 most common words
Word list - We will use AI to generate the list of 'learning units'
Synonyms job - (future) - review all words for good and bad synonyms
Error messages job - (future)
Sentences job - we will remove tatoeba and make a new sentence job at some point.
Validation job (future) - we will add a job that validates the learning units

# Common words job

This is just a matter of generating the most common words and storing them in the db

## Word list job

The word list is a fixed-order list of "learning units", or simply "units". Learning units are words, fixed expressions, particle expressions, separated verbs, etc. Each learning unit can be identified by a key composed of the language code plus the normalized text , i.e., (“sv", "hålla på").
Unit ids are a db concern.
Unit form is encoded in a flexible and extendable format that can be used across all languages.

**Runtime (implementation):** The LLM job does not request all `{N}` units in one response — structured output hits provider output limits (symptom: fewer units than expected, e.g. ~300–400). The worker calls the model in **segments** of contiguous global ranks (default **320** units per call, override with env `VOCAB_UNITS_LLM_BATCH_SIZE`, allowed range 50–2000). Frequency seeds are **split round-robin** across segments so each slice has a similar number of mandatory lemmas; later segments receive a “do not reuse these surface forms” hint from earlier segments.

### Approximate Prompt

You are designing a vocabulary list for a language learning app.

Your task is to generate the most useful "learning units" for everyday spoken {LANGUAGE}.

A learning unit is:

- a single word (in any useful form: plural, gendered, conjugated), OR
- a fixed expression, OR
- a particle verb, OR
- a split expression (e.g. "se ... ut")

GOAL:
Prioritize units that help a learner start speaking and understanding real conversations quickly.

TASK:
Generate exactly {N} learning units (ranks 1..{N}).

REQUIRED SEED LEMMAS (from frequency data — not the whole list):
You MUST include ALL of the following items EXACTLY as written somewhere in the output "text" field:
{WORDLIST}

Do not modify, translate, or replace these items.
They are mandatory *anchors* only: you must ALSO add ({N} minus list size) other high-utility units so the total is exactly {N}. Do not output only the required list.

SPACING:
Interleave required seeds with additional nouns, verbs, adjectives, and expressions. Avoid long consecutive runs of prepositions, conjunctions, articles, or pronouns so learners do not burn out on function words.

RULES:

1. Prefer modern, spoken language.
2. Avoid literary, poetic, archaic, or formal-only expressions.
3. Avoid rare or domain-specific vocabulary.
4. Prefer high-utility everyday concepts.
5. Include a balanced mix of:
   - nouns
   - verbs
   - adjectives
   - function words
   - expressions (particle, fixed, split)
   Avoid many function words in a row — interleave with content words and expressions, especially early in the list.
6. Include multi-word expressions only if commonly used in speech.
7. For split expressions, use the format "verb ... particle".
8. Avoid duplicates or near-duplicates.
9. Avoid multiple forms of the same word unless clearly common in speech.
10. Keep units short (max 4 words).
11. Order by usefulness: earlier = more essential.
12. Assign rank starting at 1 and increment by 1 with no gaps.

FORM RULES:

- Include a "form" object only when clearly applicable.
- Only include fields that are obvious from the word itself.
- Do NOT guess grammatical features.

Allowed fields:

- tense: PRES | PAST | FUT
- number: SG | PL
- person: 1 | 2 | 3
- definiteness: DEF | INDEF
- degree: POS | COMP | SUP
- politeness: string
- aspect: string
- mood: string

GLOSS RULES:

- Provide a short meaning hint (1–3 words preferred)
- Not a full definition
- Not a full sentence
- Avoid repeating identical glosses excessively

OUTPUT FORMAT:

Return ONLY a valid JSON array.

Each item must follow this structure:

{
"text": "string",
"lang": "{LANG_CODE}",

"type": "WORD | PARTICLE | FIXED_EXPR | SPLIT",

"pos": "VERB | NOUN | ADJ | ADV | PRON | PREP | CONJ | DET | OTHER",

"form": { ... },

"gloss": "string",

"rank": number,

"tags": []
}

STRICT REQUIREMENTS:

- Output must be valid JSON
- No comments
- No trailing commas
- Exactly {N} items
- All required words must be included"

## Sentence job

Sentences (clozes) job creates 5 sentences that use the learning unit.
They should be designed to teach USAGE rather than meaning. "Jag gillar äpplen." is bad. "Jag åt ett äpple till frukost." is better because it's more natural and less 'duolingo fake'.
It's good to include some expression and reaction energy.
Prefer high-frequency sentence shapes. "jag kommer at ...", "jag håller på ..."
Avoid literary tone
Avoid putting the unit at the

## Input per unit

Input is the JSON schema for the learning unit

## Output per unit

Output per unit is a set of sentences that includes, per sentence:

type ClozeSentence = {
sentence: string // full sentence
cloze: string // sentence with blank
answer: string // expected answer
alternatives?: string[] // acceptable synonyms/forms
explanation?: string // optional grammar hint
tags: string[] // metadata
}

### Approximate Prompt

You are creating cloze sentences for a language learning app.

TARGET LANGUAGE: {LANGUAGE}
LEARNING UNIT: "{UNIT}" (the unit json schema )

GOAL:
Create 5 natural, spoken sentences that help a learner understand how this unit is used in real life.

RULES:

1. Use modern, everyday spoken language.
2. Prefer realistic conversational sentences (questions, short statements, reactions).
3. Avoid literary or formal sentences.
4. Avoid rare or domain-specific contexts.
5. Avoid sentences that only work inside fixed idioms (unless the unit itself is that idiom).
6. Keep sentences short (5–12 words).
7. Only one "new" concept per sentence.
8. try for 2 easy, 2 medium, 1 hard

CLOZE RULES:

- Replace the learning unit with a blank: "\_\_".
- The blank must feel natural and unambiguous.
- Do not remove surrounding words.

OUTPUT FORMAT:

[
{
"sentence": "...",
"cloze": "...",
"answer": "...",
"alternatives": ["..."],
"tags": ["..."]
"difficulty": "..."
}
]
