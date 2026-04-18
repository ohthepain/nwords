# Vocabulary and Testing Architecture and Design

This document tracks **design intent** and **where it lives in code**. Authoritative formulas and thresholds are in `packages/shared/src/constants/confidence.ts` (`updateConfidence`, `isWordKnown`, and exported constants). Build / assessment / frustration **word selection** is implemented in `apps/api/src/routes/test.ts` (Build uses `BUILD_FRONTIER_BAND_MAX` for the introduction queue). Progress and heatmap data come from `apps/api/src/routes/progress.ts`. The practice heatmap UI is `apps/web/src/components/vocab-graph.tsx`.

## Database

Users can study multiple languages. Vocabulary state is stored per user; assumed level is **per user and per target language**.

### `UserLanguageProfile`

- One row per `(userId, languageId)` (see `packages/db/prisma/schema.prisma`).
- **`assumedRank`**: frequency rank boundary from **assessment mode** (binary search). Words with `rank <= assumedRank` are treated as **assumed known** in the heatmap and related UX (they do not require a `UserWordKnowledge` row to show as “known” in the graph).
- Updated when an assessment session ends: `assumedRank` is upserted from the replayed binary-search midpoint (`computeAssessedRank` in `test.ts`), only if `assessedRank > 0`.

### `UserWordKnowledge`

One row per user per word (shared across modes). Fields match Prisma:

| Field          | Type     | Notes                                                                 |
| -------------- | -------- | --------------------------------------------------------------------- |
| `confidence`   | Float    | 0.0–1.0 internally; UI often shows percent                            |
| `timesTested`  | Int      | Total attempts across modes                                           |
| `timesCorrect` | Int      | Total correct across modes                                            |
| `lastTestedAt` | DateTime | Prior attempt timestamp (fed into staleness in Build/Frustration wrong) |
| `lastCorrect`  | Boolean  | Whether the latest attempt was correct                                |
| `streak`       | Int      | Consecutive correct; **reset on wrong** in `updateConfidence`         |

Default confidence on **first** persisted row is `0.5` in the schema; the answer handler passes `existing?.confidence ?? 0.5` into the formula.

### `Word` (vocabulary / practice constraints)

Relevant flags used by heatmap and cloze selection: `isOffensive`, `isAbbreviation` (excluded from rank band / tests), `testSentenceIds` (non-empty required to serve a cloze in practice). Ingestion sets `isTestable` for certain POS types (`apps/api/src/workers/kaikki.ts`).

### Vocabulary size and “known”

- **Verified known** (for counting and graph status): `confidence >= KNOWN_CONFIDENCE_THRESHOLD` **and** `timesTested >= KNOWN_MIN_TESTS` (`0.95` and `3` in `confidence.ts`; also referenced as `isWordKnown`).
- **Vocabulary size (per language, heatmap / build):** `assumedRank +` count of `UserWordKnowledge` rows for that language meeting the verified-known predicate, with `word.isAbbreviation === false` (see `GET /progress/heatmap`).

**Implementation note:** `GET /progress/knowledge-summary` and the score snapshot on `POST /test/sessions/:id/end` currently count “known” `UserWordKnowledge` rows **without** filtering by target `languageId`, while `assumedRank` is taken from the user’s target-language profile. The heatmap and build-mode logic use **per-language** known counts. Aligning those endpoints with per-language counts would match the graph and build behavior.

### Lean storage below assumed rank

Bulk-deleting `UserWordKnowledge` at or below `assumedRank` is **design-only**; there is no automated cleanup in the repo today.

## Confidence update rules

Each mode has its own branch in `updateConfidence(mode, correct, input)` (`confidence.ts`). No shared multiplier between Build and Frustration beyond shared wrong handling.

Shared inputs: `confidence`, `timesTested` (**before** this answer), `lastTestedAt`, `streak`, optional `now`.

### Build mode

**Correct:**

```
gain = 1 / (timesTested + 1)
timeBonus = min(daysSinceLastTest / 30, 1.0) * 0.5
adjustedGain = gain + timeBonus
rawConfidence = confidence + (1.0 - confidence) * adjustedGain
newConfidence = max(rawConfidence, confidence + MIN_CONFIDENCE_BUMP)   // MIN_CONFIDENCE_BUMP = 0.3
```

**Wrong:**

```
penalty = 1 / (timesTested + 1)
timeFactor = min(daysSinceLastTest / 30, 1.0)
adjustedPenalty = penalty * (1.0 + timeFactor)
newConfidence = confidence * (1.0 - adjustedPenalty)
```

(clamped to `[0, 1]`.)

### Assessment mode

Binary measurement: correct → `1.0`, wrong → `0.0`. Streak still updates (+1 / reset) like other modes.

### Frustration mode

**Correct:** same structure as Build but **no** time bonus; gain scaled by `0.5`, with the same **minimum bump** `MIN_CONFIDENCE_BUMP`.

**Wrong:** identical to Build wrong (`buildWrong`).

### Constants (single source of truth)

| Constant                     | Value | Role                                      |
| ---------------------------- | ----- | ----------------------------------------- |
| `MIN_CONFIDENCE_BUMP`        | 0.3   | Min increase on correct (Build/Frustration) |
| `FRUSTRATION_WORD_MIN_TESTS` | 5     | Min `timesTested` to qualify as frustration pool |
| `KNOWN_CONFIDENCE_THRESHOLD` | 0.95  | “Known” for size + build bucket boundaries |
| `KNOWN_MIN_TESTS`            | 3     | Min tests for “known”                     |

Build-only selection tuning (`VocabBuildSettings`: band width, working-set target, confidence bar, strategy percentages) lives in `@nwords/shared` as `VOCAB_BUILD_SETTINGS_DEFAULTS`; **Admin → Site settings** can override them (stored in `app_settings.vocab_build_settings` JSON, merged on read). `handleBuildNext` in `apps/api/src/routes/test.ts` consumes the merged settings.

## Testing modes

### Assessment mode

**Purpose:** Estimate `assumedRank` via binary search on ranks `1`–`10000`.

- After each answer, bounds update: correct → raise low to `rank + 1`; wrong → lower high to `rank - 1`.
- **Stop when** `(high - low) < ASSESSMENT_CONVERGE_THRESHOLD` (**50**) **or** `wordsTestedCount >= ASSESSMENT_MAX_QUESTIONS` (**30**).
- On converge, response includes `assumedRank = floor((low + high) / 2)`; on end-session, that value is persisted to `UserLanguageProfile` when `> 0`.

### Build mode (signed-in)

**Purpose:** Expand vocabulary within the same **visible heatmap slice** as the vocab graph, using a single **active band** and simple **strategy rolls** (no mood bucket, no territory cadence, no separate “new vs shaky” bucket machinery).

**Graph slice:** Same as before: words with `rank` 1–10000, not offensive, not abbreviation, ordered by `rank`, truncated to `n = min(totalInRange, ceil(baseline * 1.2))` with `baseline = max(assumedRank, vocabSize, 50)`. The slice is then padded to the heatmap’s `displayCount` using `computeHeatmapGridMetrics` (`@nwords/shared`), matching `vocab-graph.tsx`.

**Active band:** Column-major cells starting at the **first column after conquered territory** (same geometry as the graph’s “new words” column), capped by **`frontierBandMax`**. Server helper: `computeBuildModeActiveBandRows` in `@nwords/shared` + `loadBuildActiveBandContext` in `test.ts` (loads knowledge, marks clozable lemmas).

**Working set:** Clozable lemmas in the band with `timesTested > 0`, not verified-known, and with `confidence == null` or `confidence < confidenceCriterion`. Target size **`workingSetSize`**. When the count of such lemmas is **below** the target, `rollBuildStrategy` **boosts** the introduce share (same formula client and server use for dev previews).

**Strategies (one random draw per question, then ordered fallbacks):**

- **Reinforce** — sample from the working set (rank-ordered head spread).
- **Introduce** — `timesTested === 0`, clozable, in band.
- **Band walk** — any clozable non-verified-known lemma in the band.

Percentages **`pReinforceWorkingSet`**, **`pIntroduce`**, **`pBandWalk`** must sum to **100** (admin validated).

**Column focus:** If `columnFocusWordIds` is set and the session has not yet answered every listed id once, **only** that ordered pass runs (per-word shuffle retries), same as before.

**Fallback:** Random `pickRandomWordIdForCloze` restricted to clozable ids in the band (rank window from band min/max) if strategy passes exhaust retries.

**Guests:** Build mode **requires sign-in**. Guest session create with `vocabMode: "BUILD"` returns **403**; `/next` on a guest Build session returns **403**. The web app redirects guests away from `?vocabMode=BUILD` to Assessment.

### Frustration mode

**Purpose:** Short drills on stubborn words. **Requires signed-in user.**

**Pool:** `timesTested >= FRUSTRATION_WORD_MIN_TESTS` (**5**), `confidence < 0.5`, target language, not abbreviation, has `testSentenceIds`. Ordered by `lastTestedAt` ascending, then `confidence` ascending; **take 20**. Prefer words not yet seen this session; pick uniformly among the first `min(poolLength, 10)` of that pool.

### Spaced repetition (lightweight)

No `nextReviewAt`. Lower confidence and staleness on wrong answers skew selection toward non-confident items; Build’s active band, working-set target, and strategy percents add structure on top.

## UI: vocab graph

Heatmap loads `GET /api/progress/heatmap` (via web proxy). Cell `status` is `known` if verified known **or** `rank <= assumedRank`; else `learning` if a knowledge row exists; else `untested`.

**`testSentenceCount`:** Count of `sentence_word` rows for that lemma to target-language `sentence` rows with `markedForRemoval === false` — same notion as admin word panel “Sentences” / `getWordSentences`. **`curatedTestSentenceCount`:** `word.testSentenceIds.length` (curated list; can drift from links). Cloze resolution in `parallel-hint.ts` uses curated IDs first, then merges linked sentences when the curated pool is empty or yields no candidates.

**Territory slab (visual “conquered” column):** uses measured confidence `>= 0.9` (`TERRITORY_MIN_CONFIDENCE` in `vocab-graph.tsx`), which is **slightly below** the `0.95` verified-known threshold — purely a display choice.

## API use cases (formulas)

| #   | Use case                    | Implementation                                                                 |
| --- | --------------------------- | ------------------------------------------------------------------------------ |
| 1   | Correct in Build            | `updateConfidence("BUILD", true, …)`                                           |
| 2   | Wrong in Build              | `updateConfidence("BUILD", false, …)`                                          |
| 3   | Count vocabulary (heatmap)  | `assumedRank +` per-language verified-known count (non-abbreviation)           |
| 4   | Correct in Assessment       | confidence `1.0`                                                               |
| 5   | Wrong in Assessment         | confidence `0.0`                                                               |
| 6   | Correct in Frustration      | `updateConfidence("FRUSTRATION", true, …)`                                     |
| 7   | Wrong in Frustration        | same as Build wrong                                                            |

Answer recording: `POST` … `/test/sessions/:id/answer` in `test.ts` (creates `TestAnswer`, updates session counters, upserts `UserWordKnowledge`).

## Resolved design decisions

- **Frustration qualification:** `timesTested >= 5` and `confidence < 0.5` in the current selector (plus test sentences required).
- **No confidence floor** in formulas beyond clamping to `[0,1]`; Assessment can set `0.0`. Build and Frustration correct answers always move by at least `MIN_CONFIDENCE_BUMP` (**0.3**).
