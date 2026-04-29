import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BuildColumnFocusPayload } from "~/lib/vocab-graph-column-utils";
import {
  GAP_PX,
  GRAPH_MIN_WIDTH_PX,
  MIN_TERRITORY_COLUMN_INTRO_LEMMAS,
  TERRITORY_MIN_CONFIDENCE,
  cellConqueredForTerritoryColumn,
  completedColsFromLeft as countCompletedColsFromLeft,
  findUntestedTerritoryIntroColumnPayload,
  graphWidthBasePx,
  heatmapTargetCellCount,
  squareSizePx,
} from "~/lib/vocab-graph-column-utils";

/** Extra `UserWordKnowledge` fields when heatmap is loaded with `dev=1` (admin dev mode). */
export type VocabGraphKnowledgeDebug = {
  rowId: string;
  lastTestedAt: string | null;
  lastCorrect: boolean;
  streak: number;
  createdAt: string;
  updatedAt: string;
};

export type VocabGraphCell = {
  wordId: string;
  rank: number;
  lemma: string;
  status: string;
  confidence: number | null;
  timesTested: number;
  timesCorrect: number;
  /** `SentenceWord` rows to non-removed target-language sentences (joinable cloze count). */
  testSentenceCount: number;
  /** Raw `testSentenceIds.length` from API when present (may exceed joinable cloze count). */
  curatedTestSentenceCount?: number;
  /** Present only when the heatmap request used `dev=1`; `null` means no knowledge row. */
  knowledgeDebug?: VocabGraphKnowledgeDebug | null;
};

type HeatmapResponse = {
  from: number;
  to: number;
  languageId: string;
  assumedRank: number;
  /** Verified-known words in this language (high confidence + enough tests). */
  knownWords: number;
  /** assumedRank + knownWords — same notion as dashboard. */
  vocabSize: number;
  cells: VocabGraphCell[];
};

/** Background color for a cell from continuous confidence; null = untested (neutral). */
function cellBackground(confidence: number | null): string {
  if (confidence === null) {
    return "var(--vocab-graph-untested)";
  }
  const lowWeight = Math.round((1 - confidence) * 100);
  return `color-mix(in oklch, var(--vocab-graph-confidence-low) ${lowWeight}%, var(--vocab-graph-confidence-high))`;
}

/** Backdrop behind fully verified columns (“conquered” territory). */
function territorySlabFill(): string {
  return "var(--vocab-graph-territory-conquered)";
}

/** Floor for the auto-suggested session goal — fewer than this feels trivial. */
const MIN_SESSION_GOAL = 6;

export type TerritoryColumnAdvancedPayload = BuildColumnFocusPayload & {
  /** Word IDs filtered to only those with joinable cloze sentences (testSentenceCount > 0). */
  practiceWordIds: string[];
};

export function VocabGraph({
  languageId,
  activeWordId,
  answerFlash,
  showDevGrid,
  pointerProbe = true,
  onTerritoryColumnAdvanced,
  onLoadStateChange,
}: {
  languageId: string;
  /** Current question word — brief highlight when it changes. */
  activeWordId: string | null;
  /** After each recorded answer: triggers 4× color transition animation. */
  answerFlash: {
    wordId: string;
    confidence: number;
    tick: number;
    timesCorrect?: number;
    timesTested?: number;
  } | null;
  /** When true (admin dev mode), show computed row/column count for the heatmap grid. */
  showDevGrid?: boolean;
  /** When false, disable drag/hover word list (e.g. settings live preview). */
  pointerProbe?: boolean;
  /** Fires once when a new column becomes fully conquered and the next column has words to learn. */
  onTerritoryColumnAdvanced?: (payload: TerritoryColumnAdvancedPayload) => void;
  /** Heatmap fetch lifecycle (e.g. gate Build “Start practice” until loaded). */
  onLoadStateChange?: (state: "idle" | "loading" | "error") => void;
}) {
  const [cells, setCells] = useState<VocabGraphCell[]>([]);
  const [assumedRank, setAssumedRank] = useState(0);
  const [vocabSize, setVocabSize] = useState(0);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error">("loading");
  const [questionFlashId, setQuestionFlashId] = useState<string | null>(null);
  const [answerAnim, setAnswerAnim] = useState<{
    wordId: string;
    fromBg: string;
    toBg: string;
    useTo: boolean;
    step: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadState("loading");
    void (async () => {
      try {
        const u = new URL("/api/progress/heatmap", window.location.origin);
        u.searchParams.set("from", "1");
        u.searchParams.set("to", "10000");
        u.searchParams.set("languageId", languageId);
        if (showDevGrid) u.searchParams.set("dev", "1");
        const res = await fetch(u.toString(), { credentials: "include" });
        if (!res.ok) {
          throw new Error(await res.text());
        }
        const data = (await res.json()) as HeatmapResponse;
        if (cancelled) return;
        setCells(data.cells);
        setAssumedRank(data.assumedRank);
        setVocabSize(data.vocabSize);
        setLoadState("idle");
      } catch {
        if (!cancelled) setLoadState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [languageId, showDevGrid]);

  useLayoutEffect(() => {
    onLoadStateChange?.(loadState);
  }, [loadState, onLoadStateChange]);

  const targetCells = heatmapTargetCellCount(assumedRank, vocabSize, cells.length);
  const square = squareSizePx(targetCells);
  const baseW = graphWidthBasePx(targetCells);
  /** Heatmap width follows {@link graphWidthBasePx} only; narrow viewports scroll via the wrapper. */
  const graphW = Math.max(GRAPH_MIN_WIDTH_PX, baseW);
  const step = square + GAP_PX;
  const numCols = Math.max(1, Math.floor((graphW + GAP_PX) / step));
  const displayCount = Math.min(cells.length, Math.max(numCols, Math.ceil(targetCells / numCols) * numCols));
  const numRows = Math.max(1, Math.ceil(displayCount / numCols));
  const graphH = numRows * step - GAP_PX;

  const visibleCells = useMemo(() => cells.slice(0, displayCount), [cells, displayCount]);

  /**
   * Leftmost columns where every cell is “territory conquered”: rank ≤ assumedRank, or measured
   * confidence ≥ TERRITORY_MIN_CONFIDENCE (matches Build frontier / new-words intro column index).
   */
  const completedColsFromLeft = useMemo(
    () => countCompletedColsFromLeft(visibleCells, numCols, numRows, assumedRank),
    [visibleCells, numCols, numRows, assumedRank],
  );

  // Measure available container width so we can clip conquered columns on narrow viewports.
  const outerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    if (w > 0) setContainerWidth(w);
    const ro = new ResizeObserver(([entry]) => {
      const cw = entry.contentRect.width;
      if (cw > 0) setContainerWidth(cw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // How many columns fit in the measured container (all columns when not yet measured).
  const fitCols = containerWidth !== null ? Math.max(1, Math.floor((containerWidth + GAP_PX) / step)) : numCols;

  // Skip leading conquered columns so the frontier stays roughly centred in the viewport.
  const skipCols = useMemo(() => {
    if (fitCols >= numCols) return 0;
    const centerPos = Math.floor(fitCols / 2);
    return Math.max(0, Math.min(completedColsFromLeft - centerPos, numCols - fitCols));
  }, [fitCols, numCols, completedColsFromLeft]);

  const renderNumCols = numCols - skipCols;
  const renderSkipIdx = skipCols * numRows;
  const renderCells = useMemo(() => visibleCells.slice(renderSkipIdx), [visibleCells, renderSkipIdx]);
  const renderGraphW = renderNumCols * step - GAP_PX;
  const renderCompletedCols = Math.max(0, completedColsFromLeft - skipCols);
  const renderTerritoryWidthPx = renderCompletedCols > 0 ? renderCompletedCols * step - GAP_PX : 0;

  const heatmapEpochRef = useRef("");
  const prevCompletedColsRef = useRef<number | null>(null);
  const lastFiredCompletedColsRef = useRef<number | null>(null);

  useEffect(() => {
    if (!onTerritoryColumnAdvanced || loadState !== "idle" || visibleCells.length === 0) return;

    const epoch = `${languageId}:${visibleCells.length}:${assumedRank}:${vocabSize}`;
    if (heatmapEpochRef.current !== epoch) {
      heatmapEpochRef.current = epoch;
      prevCompletedColsRef.current = null;
      lastFiredCompletedColsRef.current = null;
    }

    const c = completedColsFromLeft;
    if (prevCompletedColsRef.current === null) {
      prevCompletedColsRef.current = c;
      return;
    }

    if (c > prevCompletedColsRef.current && lastFiredCompletedColsRef.current !== c) {
      if (c < numCols) {
        const intro = findUntestedTerritoryIntroColumnPayload(
          visibleCells,
          numCols,
          numRows,
          c,
          assumedRank,
          MIN_TERRITORY_COLUMN_INTRO_LEMMAS,
        );
        if (intro) {
          onTerritoryColumnAdvanced(intro);
        }
        lastFiredCompletedColsRef.current = c;
      }
    }

    prevCompletedColsRef.current = c;
  }, [
    languageId,
    loadState,
    visibleCells,
    numCols,
    numRows,
    completedColsFromLeft,
    assumedRank,
    vocabSize,
    onTerritoryColumnAdvanced,
  ]);

  const conqueredWords = completedColsFromLeft * numRows;

  /**
   * Scan forward from the current conquered edge, column by column. For each
   * prospective stopping column, record the cumulative unlearned words needed
   * and the new conquered territory gained — so we can pick a high-ratio goal
   * and map a user-chosen word count to a concrete territory target.
   */
  const forwardScan = useMemo(() => {
    const stats: {
      colsAdded: number;
      cumToLearn: number;
      newConquered: number;
      ratio: number;
    }[] = [];
    let cum = 0;
    for (let col = completedColsFromLeft; col < numCols; col++) {
      let unlearnedInCol = 0;
      for (let row = 0; row < numRows; row++) {
        const idx = col * numRows + row;
        if (idx >= visibleCells.length) break;
        if (!cellConqueredForTerritoryColumn(visibleCells[idx], assumedRank)) unlearnedInCol++;
      }
      cum += unlearnedInCol;
      const colsAdded = col - completedColsFromLeft + 1;
      const newConquered = colsAdded * numRows;
      stats.push({
        colsAdded,
        cumToLearn: cum,
        newConquered,
        ratio: cum > 0 ? newConquered / cum : 0,
      });
    }
    return stats;
  }, [visibleCells, numCols, numRows, completedColsFromLeft, assumedRank]);

  /**
   * Suggested number of words for this session. Among the column-boundary
   * stopping points in {@link forwardScan}, pick the one that maximises
   * territory conquered per word learned (newConquered / cumToLearn). We
   * floor at {@link MIN_SESSION_GOAL} — stopping points below that are
   * trivial, so we consider only entries with cumToLearn ≥ floor. Ties on
   * ratio break toward the smaller word count (less work for same value).
   * If no entry clears the floor (i.e. not many unlearned words visible),
   * we fall back to the deepest available stopping point.
   */
  const suggestedGoalWords = useMemo(() => {
    if (forwardScan.length === 0) return 0;
    let best: (typeof forwardScan)[number] | null = null;
    for (const s of forwardScan) {
      if (s.cumToLearn < MIN_SESSION_GOAL) continue;
      if (!best) {
        best = s;
        continue;
      }
      if (s.ratio > best.ratio) best = s;
      // ratio tie → prefer smaller cumToLearn (cheaper session for same value)
      else if (s.ratio === best.ratio && s.cumToLearn < best.cumToLearn) best = s;
    }
    if (best) return best.cumToLearn;
    // No stopping point ≥ floor: use the deepest reachable column's cost.
    const last = forwardScan[forwardScan.length - 1];
    return Math.max(MIN_SESSION_GOAL, last?.cumToLearn ?? 0);
  }, [forwardScan]);

  const [goalWordsOverride, setGoalWordsOverride] = useState<number | null>(null);
  const goalWords = goalWordsOverride ?? suggestedGoalWords;

  /** Deepest reachable column whose cumulative unlearned count fits in the user's goal budget. */
  const goalTarget = useMemo(() => {
    let best: (typeof forwardScan)[number] | null = null;
    for (const s of forwardScan) {
      if (s.cumToLearn <= goalWords && s.cumToLearn > 0) best = s;
    }
    return best;
  }, [forwardScan, goalWords]);

  const goalConquered = goalTarget ? (completedColsFromLeft + goalTarget.colsAdded) * numRows : conqueredWords;

  const gridIndexForPixel = useCallback(
    (px: number, py: number): number | null => {
      if (px < 0 || py < 0) return null;
      const col = Math.floor(px / step);
      const rowFromTop = Math.floor(py / step);
      if (col < 0 || col >= renderNumCols || rowFromTop < 0 || rowFromTop >= numRows) return null;
      const rowFromBottom = numRows - 1 - rowFromTop;
      const idxInRender = col * numRows + rowFromBottom;
      const idx = renderSkipIdx + idxInRender;
      return idx >= 0 && idx < visibleCells.length ? idx : null;
    },
    [renderNumCols, numRows, step, visibleCells.length, renderSkipIdx],
  );

  const [tooltipWordId, setTooltipWordId] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const tooltipCell = useMemo(() => {
    if (!tooltipWordId) return null;
    return visibleCells.find((c) => c.wordId === tooltipWordId) ?? null;
  }, [tooltipWordId, visibleCells]);

  const updateTooltip = useCallback(
    (idx: number | null, clientX: number, clientY: number) => {
      if (idx === null) {
        setTooltipWordId(null);
        return;
      }
      const cell = visibleCells[idx];
      if (!cell) {
        setTooltipWordId(null);
        return;
      }
      setTooltipWordId(cell.wordId);
      setTooltipPos({ x: clientX, y: clientY });
    },
    [visibleCells],
  );

  const clearTooltip = useCallback(() => {
    setTooltipWordId(null);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      updateTooltip(gridIndexForPixel(x, y), e.clientX, e.clientY);
    },
    [gridIndexForPixel, updateTooltip],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const el = e.currentTarget;
      const r = el.getBoundingClientRect();
      updateTooltip(gridIndexForPixel(e.clientX - r.left, e.clientY - r.top), e.clientX, e.clientY);
    },
    [gridIndexForPixel, updateTooltip],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      clearTooltip();
    },
    [clearTooltip],
  );

  const onPointerLeave = useCallback(() => {
    clearTooltip();
  }, [clearTooltip]);

  const lastQuestionFlashRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeWordId) {
      lastQuestionFlashRef.current = null;
      return;
    }
    if (!visibleCells.some((c) => c.wordId === activeWordId)) return;
    if (lastQuestionFlashRef.current === activeWordId) return;
    lastQuestionFlashRef.current = activeWordId;
    setQuestionFlashId(activeWordId);
    const t = window.setTimeout(() => setQuestionFlashId(null), 400);
    return () => clearTimeout(t);
  }, [activeWordId, visibleCells]);

  // Answer: 8 half-steps (150ms) toggling between old and new fill + ring
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on tick only
  useEffect(() => {
    if (!answerFlash) return;
    const { wordId, confidence: nextConf, timesCorrect, timesTested } = answerFlash;

    let fromBg = "";
    let toBg = "";
    setCells((prev) => {
      const cell = prev.find((c) => c.wordId === wordId);
      if (!cell) return prev;
      fromBg = cellBackground(cell.confidence);
      toBg = cellBackground(nextConf);
      return prev.map((c) =>
        c.wordId === wordId
          ? {
              ...c,
              confidence: nextConf,
              ...(typeof timesTested === "number" && { timesTested }),
              ...(typeof timesCorrect === "number" && { timesCorrect }),
            }
          : c,
      );
    });

    if (!fromBg || !toBg) return;

    const animWordId = wordId;
    setAnswerAnim({ wordId: animWordId, fromBg, toBg, useTo: false, step: 0 });

    let step = 0;
    const id = window.setInterval(() => {
      step += 1;
      const useTo = step % 2 === 0;
      setAnswerAnim((a) => (a && a.wordId === animWordId ? { ...a, useTo, step } : a));
      if (step >= 8) {
        clearInterval(id);
        setAnswerAnim((a) => (a && a.wordId === animWordId ? { ...a, useTo: true, step: 8 } : a));
        window.setTimeout(() => {
          setAnswerAnim((a) => (a?.wordId === animWordId ? null : a));
        }, 150);
      }
    }, 150);

    return () => clearInterval(id);
  }, [answerFlash?.tick]);

  if (loadState === "error") {
    return (
      <p className="text-xs text-muted-foreground">
        Could not load vocabulary graph. Try again after signing in with a target language.
      </p>
    );
  }

  if (loadState === "loading" && cells.length === 0) {
    return <p className="text-xs text-muted-foreground">Loading vocabulary graph…</p>;
  }

  if (cells.length === 0) {
    return <p className="text-xs text-muted-foreground">No frequency-ranked words found for this language yet.</p>;
  }

  return (
    <div ref={outerRef} className="relative flex w-full min-w-0 flex-col space-y-2">
      <div className="flex w-full justify-center">
        <div className="flex max-w-full flex-wrap items-baseline justify-center gap-x-3 gap-y-1 text-center">
          <p className="text-xs text-muted-foreground tabular-nums">
            <span className="text-foreground/80 font-medium">
              Last tested rank {assumedRank > 0 ? assumedRank.toLocaleString() : "—"}
            </span>
            <span className="mx-1.5 text-muted-foreground/70">·</span>
            <span title="Estimated words you know: words below your assumed rank plus words you’ve verified by practice">
              Vocabulary size: ~{vocabSize.toLocaleString()} words
            </span>
            {showDevGrid && (
              <>
                <span className="mx-1.5 text-muted-foreground/70">·</span>
                <span
                  className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[10px] text-muted-foreground/90"
                  title={`Heatmap: ${displayCount.toLocaleString()} of ${cells.length.toLocaleString()} ranks loaded from API`}
                >
                  <span>
                    {numRows}×{numCols} · {square}px
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="text-muted-foreground/70">e.g.</span>
                    <span
                      className="rounded-[1px] border border-border/60 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_40%,transparent)]"
                      style={{
                        width: square,
                        height: square,
                        backgroundColor: cellBackground(null),
                      }}
                      aria-hidden
                    />
                  </span>
                </span>
              </>
            )}
          </p>
        </div>
      </div>
      <div className="flex w-full justify-center">
        <div className="flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs tabular-nums text-center">
          <span className="text-foreground/80">
            Conquered: <span className="font-medium">{conqueredWords.toLocaleString()}</span> words
          </span>
          {forwardScan.length > 0 && suggestedGoalWords > 0 && (
            <>
              <span className="text-muted-foreground/70">·</span>
              <label className="flex items-center gap-1 text-muted-foreground">
                <span>Session goal: learn</span>
                <input
                  type="number"
                  min={0}
                  value={goalWords}
                  onChange={(e) => {
                    const v = Number.parseInt(e.target.value, 10);
                    setGoalWordsOverride(Number.isFinite(v) && v >= 0 ? v : 0);
                  }}
                  className="w-14 rounded border border-border/60 bg-background px-1 py-0.5 text-center text-foreground"
                />
                <span>
                  Goal: <span className="font-medium text-foreground/80">{goalConquered.toLocaleString()}</span> words
                </span>
              </label>
            </>
          )}
        </div>
      </div>
      <div className="flex w-full justify-center">
        <div className="relative rounded-lg border border-border/60 bg-muted/20 p-2 touch-none select-none">
          <div
            role="img"
            aria-label="Vocabulary confidence graph"
            className="relative overflow-hidden rounded-md transition-colors duration-200"
            style={{
              width: renderGraphW,
              height: Number.isFinite(graphH) ? graphH : 8,
              backgroundColor: "var(--vocab-graph-territory-open)",
            }}
            onPointerDown={pointerProbe ? onPointerDown : undefined}
            onPointerMove={pointerProbe ? onPointerMove : undefined}
            onPointerUp={pointerProbe ? onPointerUp : undefined}
            onPointerCancel={pointerProbe ? onPointerUp : undefined}
            onPointerLeave={pointerProbe ? onPointerLeave : undefined}
          >
            {renderTerritoryWidthPx > 0 ? (
              <div
                className="pointer-events-none absolute left-0 top-0 z-0 rounded-l-[3px]"
                style={{
                  width: renderTerritoryWidthPx,
                  height: graphH,
                  backgroundColor: territorySlabFill(),
                }}
                aria-hidden
                title={`${completedColsFromLeft} conquered column${completedColsFromLeft === 1 ? "" : "s"} (assumed band or ≥${Math.round(TERRITORY_MIN_CONFIDENCE * 100)}% confidence)`}
              />
            ) : null}
            <div
              className="relative z-10 grid"
              style={{
                width: renderGraphW,
                height: graphH,
                gridTemplateColumns: `repeat(${renderNumCols}, ${square}px)`,
                gridAutoRows: `${square}px`,
                gap: GAP_PX,
              }}
            >
              {renderCells.map((c, i) => {
                const col = Math.floor(i / numRows);
                const rowFromBottom = i % numRows;
                const rowFromTop = numRows - 1 - rowFromBottom;
                const style: React.CSSProperties = {
                  gridColumn: col + 1,
                  gridRow: rowFromTop + 1,
                };

                const inAnswer = answerAnim?.wordId === c.wordId && answerAnim.step < 8;
                const inQuestionFlash = questionFlashId === c.wordId;

                let background = cellBackground(c.confidence);
                if (inAnswer && answerAnim) {
                  background = answerAnim.useTo ? answerAnim.toBg : answerAnim.fromBg;
                }

                const isActive = activeWordId === c.wordId;
                const ring =
                  inAnswer || inQuestionFlash
                    ? "0 0 0 1px color-mix(in srgb, var(--color-ring) 50%, transparent)"
                    : isActive
                      ? "0 0 0 1px white"
                      : undefined;

                return (
                  <div
                    key={c.wordId}
                    className={`rounded-[1px] ${inQuestionFlash && !inAnswer ? "vocab-graph-cell-qflash" : ""}`}
                    style={{
                      ...style,
                      width: square,
                      height: square,
                      backgroundColor: background,
                      boxShadow: ring,
                    }}
                    title={`${c.lemma} (#${c.rank})`}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>
      {pointerProbe && tooltipCell && (
        <div
          className="fixed z-50 max-w-[min(22rem,calc(100vw-1.5rem))] rounded-lg border border-border/80 bg-card/95 backdrop-blur-md px-3 py-2 text-xs shadow-lg pointer-events-none"
          style={{
            left: tooltipPos.x + 12,
            top: tooltipPos.y + 16,
          }}
          aria-live="polite"
        >
          <p className="font-medium text-foreground">
            {tooltipCell.lemma} <span className="text-muted-foreground font-normal">#{tooltipCell.rank}</span>
          </p>
          <p className="text-muted-foreground mt-0.5">
            Confidence: {tooltipCell.confidence !== null ? `${Math.round(tooltipCell.confidence * 100)}%` : "untested"}
          </p>
          <p className="text-muted-foreground">
            {tooltipCell.timesCorrect}/{tooltipCell.timesTested} correct
          </p>
          {showDevGrid && tooltipCell.knowledgeDebug !== undefined && (
            <div className="mt-2 border-t border-border/50 pt-2 font-mono text-[10px] leading-relaxed text-muted-foreground space-y-0.5">
              <p>
                <span className="text-muted-foreground/80">status</span> {tooltipCell.status}
              </p>
              <p className="break-all">
                <span className="text-muted-foreground/80">wordId</span> {tooltipCell.wordId}
              </p>
              {tooltipCell.knowledgeDebug === null ? (
                <p>
                  <span className="text-muted-foreground/80">UserWordKnowledge</span> (no row)
                </p>
              ) : (
                <>
                  <p className="break-all">
                    <span className="text-muted-foreground/80">rowId</span> {tooltipCell.knowledgeDebug.rowId}
                  </p>
                  <p>
                    <span className="text-muted-foreground/80">lastTestedAt</span>{" "}
                    {tooltipCell.knowledgeDebug.lastTestedAt ?? "—"}
                  </p>
                  <p>
                    <span className="text-muted-foreground/80">lastCorrect</span>{" "}
                    {String(tooltipCell.knowledgeDebug.lastCorrect)}
                  </p>
                  <p>
                    <span className="text-muted-foreground/80">streak</span> {tooltipCell.knowledgeDebug.streak}
                  </p>
                  <p className="break-all">
                    <span className="text-muted-foreground/80">createdAt</span> {tooltipCell.knowledgeDebug.createdAt}
                  </p>
                  <p className="break-all">
                    <span className="text-muted-foreground/80">updatedAt</span> {tooltipCell.knowledgeDebug.updatedAt}
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
