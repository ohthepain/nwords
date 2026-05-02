# New clozes pipeline

The tatoeba sentences didn't work out. way too many sentences and the don't sound natural.

## Goals

Prefer high-frequency sentence shapes. 
Avoid sentences that don't sound natural. For example "Mannen äter bröd." sounds like tatoeba/duolingo.
Focus on everyday conversation.
Avoid literary tone.
Avoid archaic language an rarely-used expressions.
Avoid literary tone.
Add some light/humor/fun.
Clozes should be good for testing. For example "bilen är röd" lacks context for effective testing.
Sentences should not be too long or too short. 5-12 words is usually appropriate.
Sentences should only introduce 1 new concept. The rest of the sentence should be high-frequence words.

## Testing structure

- 5 clozes per unit
- word types
  - verbs : cloze the main verb (Jag _äter_ lunch nu.)
  - particles/prepositions : cloze the tricky part (Jag tänker _på_ dig.)
  - split expressions : close both parts (Du _ser_ mycket _fin_ ut.)

## Example prompt (please fix this)

You are generating cloze sentences for a language learning app.

INPUT:
{UNIT_JSON}

GOAL:
Generate 10 candidate sentences that show how this unit is used in real spoken language.

LANGUAGE RULES:
- Use modern, everyday spoken language
- Prefer conversational structures (questions, short statements)
- Avoid literary, formal, or archaic phrasing
- Avoid rare or domain-specific contexts

SEEDING RULES:
Try to make some of the sentences start with:
  "Jag __",
  "Vill du __?",
  "Har du __?",
  "Vi ska __",
  "Kan du __?"

SENTENCE RULES:
- 5–12 words
- Only 1 new concept per sentence
- Must sound natural and realistic
- Avoid generic textbook sentences

TYPE-SPECIFIC RULES:

- VERB: Cloze the main verb
- PARTICLE/PREPOSITION: Cloze the particle
- SPLIT: Cloze both parts
- FIXED_EXPR: Cloze the full expression
- NOUN: Prefer object position

CLOZE RULES:
- Replace the unit with "__"
- The blank must be unambiguous
- Do not remove surrounding words

VARIETY REQUIREMENTS:
- At least 2 questions
- At least 2 statements
- At least 1 multi-sentence example

OUTPUT:
Return 10 items in JSON:

[
  {
    "sentence": "...",
    "cloze": "...",
    "answer": "...",
    "alternatives": ["..."],
    "difficulty": "easy | medium | hard",
    "tags": ["spoken", "question", ...]
  }
]

## Prompt input

input is just the JSON schema for the learning unit

## How to generate the list of clozes for a word

Generate 10 clozes and then choose the best ones. 
1 of the 10 should be multi-sentence. for example "Vill du ha kaffe? Ja, jag vill _gärna_ kaffe."
Choose 2 easy, 2 medium, 1 hard.
Order the list easy to hard.
Selection critera to narrow the 10 down to 5:
- Overly “correct” textbook sentences - counts against
- Too many rare words in one sentence - counts against
- Clozes that are ambiguous - counts against
- Sentences nobody would ever say - counts against
- Overusing idioms - counts against
- Subtle humour - counts for
- Sounds tough and "black" - counts for
- Sounds modern - counts for
- Sounds natural - counts for
- test word is first or last word in sentence - counts against
- abstract usage - counts against


