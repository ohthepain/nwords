# Build Mode UX

## Vocab Graph

The user's vocabulary is represented by the vocab graph — a grid of squares (one per word), colored by confidence. Visual inspiration: GitHub contribution graph.

Displayed directly above the "build vocabulary" test UI.

### Square Layout

- Word 1 is bottom-left, word 2 is above it.
- When a column is full, continue at the bottom of the next column to the right.

### Square Color

Colors reflect confidence on a continuous scale:

- **Grey** — untested.
- **Red** (bright → 10% opacity) — below 50% confidence. Bright red = frustration word, dims gradually as confidence approaches 50%.
- **Green** (10% opacity → bright) — 50% confidence and above. Dims gradually toward 50%, full green = full confidence.

### Square Size

Cell edge length (in CSS pixels) depends on how many ranks we **show** in the heatmap (see [Number of squares](#number-of-squares)), not on how many words exist in the corpus:

| Visible ranks (cap) | Square size |
| ------------------- | ----------- |
| ≤ 100               | 16×16 px    |
| ≤ 200               | 12×12 px    |
| ≤ 400               | 8×8 px      |
| ≤ 1000              | 6×6 px      |
| ≤ 2000              | 4×4 px      |
| > 2000              | 2×2 px      |

Square size transitions (e.g., crossing from 100 → 101 visible ranks) can be jarring — acceptable for now.

### Graph Size

Total width before the mobile 50% shrink:

| Visible ranks (cap) | Width  |
| ------------------- | ------ |
| ≤ 400               | 360 px |
| ≤ 1000              | 640 px |
| > 1000              | 700 px |

Height is derived from width, square size, gap, and row count. Scaled to **50% width** on narrow mobile (`max-width: 639px`).

### Number of squares

The API can return up to 10k frequency-ranked words; the UI only **renders** a window around the learner so the graph matches vocabulary scale:

1. **Baseline:** `max(assumedRank, vocabSize, 50)`.
2. **Target count:** `min(loaded cells, ceil(baseline × 1.2))`.
3. **Displayed count:** that target rounded **up** to a full row: `min(loaded, max(numCols, ceil(target / numCols) × numCols))`, where `numCols` comes from graph width and cell size.

So the block grows with level but stays a small multiple of the user’s estimated vocabulary instead of filling ten thousand cells.

### Admin dev mode

When **DEV** is on (admins only), the subtitle includes row×column count, pixel size of each cell, a sample untested swatch, and a tooltip with how many ranks are shown vs. loaded from the API.

### Animation

- **Question appears:** flash that word's square.
- **After answer:** flash the square 4 times (150ms per state) between the old and new colors, with a subtle outline during the flash.

### Interaction

The user can drag their finger or mouse across the graph to reveal a list of words under the pointer. The word list overlays the test UI.
