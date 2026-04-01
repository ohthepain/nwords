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

Based on the user's assumed vocabulary rank in the language:

| Words       | Square size |
|-------------|-------------|
| ≤ 100       | 8×8 px      |
| ≤ 200       | 6×6 px      |
| ≤ 400       | 4×4 px      |
| ≤ 1000      | 3×3 px      |
| ≤ 2000      | 2×2 px      |
| > 2000      | 1×1 px      |

Square size transitions (e.g., crossing from 100 → 101 words) can be jarring — acceptable for now.

### Graph Size

| Words       | Width  |
|-------------|--------|
| ≤ 400       | 400 px |
| ≤ 1000      | 600 px |
| > 2000      | 800 px |

Height is derived from width and square size. Scaled to 50% on mobile.

### Animation

- **Question appears:** flash that word's square.
- **After answer:** flash the square 4 times (150ms per state) between the old and new colors, with a subtle outline during the flash.

### Interaction

The user can drag their finger or mouse across the graph to reveal a list of words under the pointer. The word list overlays the test UI.
