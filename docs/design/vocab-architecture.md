# Vocabulary and Testing Architecture and Design

This document tracks **design intent** and **where it lives in code**. Authoritative formulas and thresholds are in `packages/shared/src/constants/confidence.ts` (`updateConfidence`, `isWordKnown`, and exported constants). Build / assessment / frustration **word selection** is implemented in `apps/api/src/routes/test.ts`. Progress and heatmap data come from `apps/api/src/routes/progress.ts`. The practice heatmap UI is `apps/web/src/components/vocab-graph.tsx`.

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
newConfidence = max(rawConfidence, confidence + MIN_CONFIDENCE_BUMP)   // MIN_CONFIDENCE_BUMP = 0.2
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
| `MIN_CONFIDENCE_BUMP`        | 0.2   | Min increase on correct (Build/Frustration) |
| `FRUSTRATION_WORD_MIN_TESTS` | 5     | Min `timesTested` to qualify as frustration pool |
| `KNOWN_CONFIDENCE_THRESHOLD` | 0.95  | “Known” for size + build bucket boundaries |
| `KNOWN_MIN_TESTS`            | 3     | Min tests for “known”                     |

## Testing modes

### Assessment mode

**Purpose:** Estimate `assumedRank` via binary search on ranks `1`–`10000`.

- After each answer, bounds update: correct → raise low to `rank + 1`; wrong → lower high to `rank - 1`.
- **Stop when** `(high - low) < ASSESSMENT_CONVERGE_THRESHOLD` (**50**) **or** `wordsTestedCount >= ASSESSMENT_MAX_QUESTIONS` (**30**).
- On converge, response includes `assumedRank = floor((low + high) / 2)`; on end-session, that value is persisted to `UserLanguageProfile` when `> 0`.

### Build mode (signed-in)

**Purpose:** Expand vocabulary within the same **lemma band** as the vocab graph.

**Graph band:** Words with `rank` 1–10000, not offensive, not abbreviation, ordered by `rank`. The band is truncated to the first `n` lemmas where `n = min(totalInRange, ceil(baseline * 1.2))` and `baseline = max(assumedRank, vocabSize, 50)`. This matches `heatmapTargetCellCount` in `vocab-graph.tsx` (ordinal cap, not a raw rank cutoff).

**Preflight selection (before weighted buckets):**

1. **Territory opening:** For the first `BUILD_TERRITORY_OPENING` (**5**) questions, prefer the lowest-rank **unverified** words in the band (words lacking verified-known knowledge). Words with `timesTested - timesCorrect >= BUILD_HEAVY_MISS_THRESHOLD` (**8**) are de-emphasized in this opening only.
2. **Territory revisit:** After the opening, every `BUILD_TERRITORY_REVISIT_EVERY` (**4**th) question revisits that territory pool (`BUILD_TERRITORY_HEAD_SPREAD` **5** for spread).
3. **Frontier:** Every `BUILD_FRONTIER_EVERY` (**6**th) question targets the **lowest rank** in-band that is not yet verified known (global frontier in the visible slice, including gaps below `assumedRank`).

**Buckets (weighted random when mood eligible):** `BUILD_WEIGHT_NEW` **48%** new, `BUILD_WEIGHT_SHAKY` **37%** shaky, remainder **~15%** mood. If not eligible for mood (see below), only new vs shaky are rolled, preserving the **48 : 37** ratio.

- **New:** In-band, `rank > assumedRank`, no `UserWordKnowledge` row yet, has test sentences; capped to `BUILD_CANDIDATE_CAP` (**45**), rank-ordered. Sampling uses `BUILD_NEW_SPREAD` (**6**) and session exclusion spread `BUILD_SESSION_EXCLUSION_SPREAD` (**28**) inside the resolver.
- **Shaky:** In-band knowledge rows that are **not** verified known (`KNOWN_*` thresholds); ordered by word rank, then `lastTestedAt`, then `confidence`; capped at **45**.
- **Mood:** Verified-known words in-band; only if `eligibleMood`.

**Mood eligibility:** `tailConsecutiveWrongs(sessionAnswers) >= BUILD_MOOD_MIN_STREAK_WRONG` (**2**) — i.e. **last two answers in this session** are wrong, not the persisted `UserWordKnowledge.streak`.

**Guests:** `handleBuildGuestNext` uses a widening random rank window (no profile / knowledge).

### Frustration mode

**Purpose:** Short drills on stubborn words. **Requires signed-in user.**

**Pool:** `timesTested >= FRUSTRATION_WORD_MIN_TESTS` (**5**), `confidence < 0.5`, target language, not abbreviation, has `testSentenceIds`. Ordered by `lastTestedAt` ascending, then `confidence` ascending; **take 20**. Prefer words not yet seen this session; pick uniformly among the first `min(poolLength, 10)` of that pool.

### Spaced repetition (lightweight)

No `nextReviewAt`. Lower confidence and staleness on wrong answers skew selection toward shaky items; Build territory / frontier cadence adds structure on top.

## UI: vocab graph

Heatmap loads `GET /api/progress/heatmap` (via web proxy). Cell `status` is `known` if verified known **or** `rank <= assumedRank`; else `learning` if a knowledge row exists; else `untested`.

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
- **No confidence floor** in formulas beyond clamping to `[0,1]`; Assessment can set `0.0`. Build and Frustration correct answers always move by at least `MIN_CONFIDENCE_BUMP` (**0.2**).
