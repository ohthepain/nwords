# Vocabulary and Testing Architecture and Design

## Database

The user can study as many languages as they want. They have only one native language.

### UserWordKnowledge record

One entry per user per word (across all modes). Fields:

| Field          | Type     | Notes                                                   |
| -------------- | -------- | ------------------------------------------------------- |
| `confidence`   | Float    | 0.0–1.0 internally, displayed as 0–100%                 |
| `timesTested`  | Int      | Total attempts across all modes                         |
| `timesCorrect` | Int      | Total correct across all modes                          |
| `lastTestedAt` | DateTime | Timestamp of most recent attempt                        |
| `lastCorrect`  | Boolean  | Whether the most recent attempt was correct             |
| `streak`       | Int      | Consecutive correct (resets on wrong). Useful for mood. |

### User's Assumed Rank

- Per user, per target language.
- The word frequency rank below which we assume the user knows all words
  with ≥ 90% confidence.
- **Vocabulary size** = assumedRank + count of words _above_ assumedRank
  where confidence ≥ 0.95 and timesTested ≥ 3.
- We can bulk-delete UserWordKnowledge rows at or below the assumed rank
  to keep the table lean — those words are "known by default".

<!-- Since users can study multiple languages, assumedRank must be per-language.
     A UserLanguageProfile table is the right approach. -->

## Confidence Update Rules

Each mode has its own formula. No shared multiplier — the modes are
different enough that separate logic is clearer.

### Build Mode Formula

On **correct** answer:

```
gain = 1 / (timesTested + 1)
timeBonus = min(daysSinceLastTest / 30, 1.0) * 0.5
adjustedGain = gain + timeBonus
rawConfidence = confidence + (1.0 - confidence) * adjustedGain
newConfidence = max(rawConfidence, confidence + 0.2)   // minimum bump of 0.2
```

Every correct answer always increases confidence by at least 0.2, even if the
formula would produce a smaller move (e.g., high timesTested, already high
confidence). The time bonus rewards recalling a word you haven't seen in a while —
nailing a word after 3 weeks is more impressive than after 5 minutes.
Caps at +0.5 extra gain after 30+ days.

On **wrong** answer:

```
penalty = 1 / (timesTested + 1)
timeFactor = min(daysSinceLastTest / 30, 1.0)
adjustedPenalty = penalty * (1.0 + timeFactor)
newConfidence = confidence * (1.0 - adjustedPenalty)
```

Key properties:

- Early tests move confidence a lot (timesTested is low → large swings)
- Established words are resilient (timesTested is high → small moves)
- Staleness hurts: forgetting a word you haven't seen in a month is
  punished up to 2x more than one you saw yesterday

### Assessment Mode Formula

Binary — this is measurement, not learning:

- Correct → confidence = 1.0
- Wrong → confidence = 0.0

### Frustration Mode Formula

These are words the user keeps getting wrong. The pattern is typically:
they get it right in the session (after just getting it wrong), then
forget it again the next day. So the formula should be **conservative
on correct, harsh on wrong** — don't let a single correct answer in
the heat of the moment inflate confidence.

On **correct** answer:

```
gain = 1 / (timesTested + 1)
rawConfidence = confidence + (1.0 - confidence) * gain * 0.5
newConfidence = max(rawConfidence, confidence + 0.2)   // minimum bump of 0.2
```

The 0.5 dampening means correct answers in frustration mode build
confidence slowly. The user needs to prove they know this word
across multiple sessions, not just immediately after seeing it.

On **wrong** answer (same as Build — no mercy):

```
penalty = 1 / (timesTested + 1)
timeFactor = min(daysSinceLastTest / 30, 1.0)
adjustedPenalty = penalty * (1.0 + timeFactor)
newConfidence = confidence * (1.0 - adjustedPenalty)
```

## Testing Modes

### Assessment Mode

**Purpose:** Measure the user's assumed rank via binary search.

- Rules are intentionally harsh — this is measurement, not learning:
  - Correct → set confidence to 1.0
  - Wrong → set confidence to 0.0
- Uses binary search on word rank to find the user's level efficiently.

#### Stopping condition

Hybrid approach: stop when the binary search range narrows below a threshold
(e.g., rank range < 50) OR after a max number of questions (e.g., 30),
whichever comes first. Binary search over ranks 1–10,000 converges in ~14
steps (log2(10000)), so 30 questions is generous and allows for some
statistical padding (e.g., 2–3 questions per rank level near the boundary).

### Build Mode

**Purpose:** Strategically expand the user's vocabulary above their assumed rank.

Word selection priority (weighted random from these buckets):

1. **New territory** (~35%) — next untested words above assumed rank, in rank order
2. **Shaky words** (~50%) — words with confidence < 0.95, prioritized by
   low confidence + high rank (focus on common words first)
3. **Mood boost** (~15%) — a word the user knows well (confidence ≥ 0.95),
   picked after ≥ 2 consecutive wrong answers

Confidence updates use the Build Mode formula.

#### Spaced repetition (lightweight)

Rather than a full SRS scheduler (Anki-style intervals), we use the confidence

- staleness model: words with lower confidence and longer time-since-tested
  naturally bubble up in the "shaky words" bucket. No need for `nextReviewAt`.
  The time factor in the wrong-answer penalty naturally handles forgetting curves.

#### Mood management

- After 2 consecutive wrong answers (tracked via `streak` on UserWordKnowledge
  or session-local state), inject a known word as a confidence boost.
- This is a word-selection concern, not a confidence-formula concern.

### Frustration Words Mode

**Purpose:** Short, focused sessions targeting the user's problem words.

Word selection: words where `timesTested` is high AND `confidence` is low.
Sorted by something like `timesTested * (1 - confidence)` descending.

- Designed for short bursts (5–10 words) that can be repeated throughout the day.
- The typical pattern: user gets it right in-session (just after seeing the
  answer), then forgets again tomorrow. So correct answers are dampened (0.5x)
  to prevent false confidence. The user has to prove it across sessions.
- Session should feel fast and high-energy (shorter time limits? gamification?).

## Schema Changes Needed

```prisma
// NEW: per-user, per-language profile (replaces single targetLanguageId approach)
model UserLanguageProfile {
  id           String   @id @default(uuid()) @db.Uuid
  userId       String   @db.Uuid
  languageId   String   @db.Uuid
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  language     Language @relation(fields: [languageId], references: [id])
  assumedRank  Int      @default(0)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([userId, languageId])
  @@map("user_language_profile")
}

model UserWordKnowledge {
  // ... existing id, userId, wordId, relations ...
  confidence   Float    @default(0.5)   // was: probability
  timesTested  Int      @default(0)
  timesCorrect Int      @default(0)
  lastTestedAt DateTime?
  lastCorrect  Boolean  @default(false) // NEW
  streak       Int      @default(0)     // NEW: consecutive correct
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  // REMOVED: known (now derived), nextReviewAt (computed on the fly)
}
```

## API Use Cases

| #   | Use Case                    | Formula                                                    |
| --- | --------------------------- | ---------------------------------------------------------- |
| 1   | Correct in Build mode       | Build correct formula (gain + time bonus)                  |
| 2   | Wrong in Build mode         | Build wrong formula (penalty + staleness)                  |
| 3   | Count user's vocabulary     | assumedRank + count(confidence ≥ 0.95 AND timesTested ≥ 3) |
| 4   | Correct in Assessment       | confidence = 1.0                                           |
| 5   | Wrong in Assessment         | confidence = 0.0                                           |
| 6   | Correct in Frustration mode | Frustration correct formula (dampened 0.5x gain)           |
| 7   | Wrong in Frustration mode   | Same wrong formula as Build (no mercy)                     |

## Resolved Design Decisions

- **Frustration word threshold:** a word must have `timesTested >= 5` to
  qualify as a frustration word. Below that it's just new/learning.
- **No confidence floor.** Confidence can drop to 0.0 (and does in Assessment).
  Instead, every correct answer in Build/Frustration has a **minimum confidence bump** of 0.2 —
  so even a word at 0.0 confidence moves to at least 0.2 on a correct answer.
  This means no word is ever truly dead; one correct answer always makes progress.
