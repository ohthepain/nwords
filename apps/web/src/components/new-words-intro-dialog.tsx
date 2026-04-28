import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

const STORAGE_KEY = "nwords.newWordsIntroVariant";

export const NEW_WORDS_INTRO_VARIANTS = ["aurora", "sunrise", "forest", "confetti", "ocean"] as const;

export type NewWordsIntroVariant = (typeof NEW_WORDS_INTRO_VARIANTS)[number];

export function readStoredNewWordsIntroVariant(): NewWordsIntroVariant {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && (NEW_WORDS_INTRO_VARIANTS as readonly string[]).includes(raw)) {
      return raw as NewWordsIntroVariant;
    }
  } catch {
    /* ignore */
  }
  return "aurora";
}

export function storeNewWordsIntroVariant(v: NewWordsIntroVariant) {
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* ignore */
  }
}

type WordLine = { wordId: string; lemma: string; rank: number };

export type NewWordsIntroDialogKind = "territory_column" | "intro_backlog";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  words: WordLine[];
  /** Lemmas with joinable cloze (subset of `words`); used for honest “practice N” copy. */
  practiceLemmaCount: number;
  /** `territory_column`: default new-words framing. `intro_backlog`: batched band backlog copy. */
  introKind?: NewWordsIntroDialogKind;
  /** Untested clozable lemmas still in the band when `introKind === "intro_backlog"`. */
  introBacklogCount?: number;
  columnIndex: number;
  busy: boolean;
  /** When false, lemmas are shown but none have cloze lines yet — primary action stays off. */
  canBeginPractice: boolean;
  /** True when words have curated `testSentenceIds` but none pass the DB join for cloze. */
  showCuratedUnlinkedCopy?: boolean;
  onBegin: () => void;
};

const VARIANT_LABELS: Record<NewWordsIntroVariant, string> = {
  aurora: "Aurora",
  sunrise: "Sunrise",
  forest: "Forest",
  confetti: "Party",
  ocean: "Ocean",
};

function variantShellClass(v: NewWordsIntroVariant): string {
  switch (v) {
    case "aurora":
      return "border-transparent bg-gradient-to-br from-violet-500/25 via-fuchsia-500/15 to-cyan-500/25 shadow-[0_0_40px_-8px_rgba(139,92,246,0.45)]";
    case "sunrise":
      return "border-amber-200/60 bg-gradient-to-br from-amber-400/30 via-rose-400/20 to-orange-300/25";
    case "forest":
      return "border-emerald-300/40 bg-gradient-to-b from-emerald-600/20 via-green-500/15 to-lime-500/10";
    case "confetti":
      return "border-pink-300/50 bg-[repeating-linear-gradient(135deg,transparent,transparent_8px,rgba(236,72,153,0.06)_8px,rgba(236,72,153,0.06)_16px)] bg-gradient-to-br from-yellow-300/25 via-sky-400/20 to-violet-400/20";
    case "ocean":
      return "border-sky-400/40 bg-gradient-to-b from-sky-500/25 via-blue-600/15 to-indigo-900/20";
  }
}

function variantTitleClass(v: NewWordsIntroVariant): string {
  switch (v) {
    case "aurora":
      return "bg-gradient-to-r from-violet-600 to-cyan-600 bg-clip-text text-transparent";
    case "sunrise":
      return "text-amber-950 dark:text-amber-100";
    case "forest":
      return "text-emerald-900 dark:text-emerald-50";
    case "confetti":
      return "text-transparent bg-clip-text bg-gradient-to-r from-rose-600 via-amber-600 to-violet-600";
    case "ocean":
      return "text-sky-950 dark:text-sky-100";
  }
}

export function NewWordsIntroDialog({
  open,
  onOpenChange,
  words,
  practiceLemmaCount,
  introKind = "territory_column",
  introBacklogCount,
  columnIndex,
  busy,
  canBeginPractice,
  showCuratedUnlinkedCopy = false,
  onBegin,
}: Props) {
  const [variant, setVariant] = useState<NewWordsIntroVariant>("aurora");

  useEffect(() => {
    if (open) setVariant(readStoredNewWordsIntroVariant());
  }, [open]);

  const setVariantPersist = (next: NewWordsIntroVariant) => {
    setVariant(next);
    storeNewWordsIntroVariant(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn("max-w-md gap-0 overflow-hidden p-0 sm:max-w-md border-2", variantShellClass(variant))}
      >
        <div className="space-y-4 p-6 pt-8">
          <DialogHeader className="space-y-3 text-center sm:text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              {introKind === "intro_backlog" ? "Intro backlog" : "New territory!"}
            </p>
            <DialogTitle className={cn("text-2xl font-bold tracking-tight", variantTitleClass(variant))}>
              {introKind === "intro_backlog" ? "Batch these new lemmas?" : "Ready for some new words?"}
            </DialogTitle>
            <DialogDescription className="text-base text-foreground/85">
              {introKind === "intro_backlog" ? (
                canBeginPractice ? (
                  <>
                    You still have{" "}
                    <span className="font-semibold text-foreground">
                      {typeof introBacklogCount === "number" ? introBacklogCount : "several"}
                    </span>{" "}
                    untested, clozable lemmas in the active band — enough that we batch the next few instead of dropping
                    you on one at random. Up to{" "}
                    <span className="font-semibold text-foreground">{practiceLemmaCount}</span> in rank order (same
                    short pass as column practice), then normal Build again.
                  </>
                ) : showCuratedUnlinkedCopy ? (
                  <>
                    This batch doesn&apos;t have cloze-ready sentences yet. Stay on general Build, or fix sentence links
                    for these lemmas.
                  </>
                ) : (
                  <>None of these lemmas have cloze-ready sentences yet. Stay on general Build for now.</>
                )
              ) : canBeginPractice ? (
                practiceLemmaCount === words.length ? (
                  <>
                    Congratulations! Column {columnIndex + 1} on your heatmap is open. You&apos;ll practice{" "}
                    <span className="font-semibold text-foreground">{words.length}</span> fresh words at the edge of
                    your territory — short, focused, and right at your level.
                  </>
                ) : (
                  <>
                    Column {columnIndex + 1} on your heatmap lists{" "}
                    <span className="font-semibold text-foreground">{words.length}</span> lemmas at the frontier.{" "}
                    <span className="font-semibold text-foreground">{practiceLemmaCount}</span> have cloze-ready
                    sentences now — we&apos;ll run through those first (in column order), then return to normal Build
                    when each has been checked once this session.
                  </>
                )
              ) : showCuratedUnlinkedCopy ? (
                <>
                  Column {columnIndex + 1} on your heatmap is open with{" "}
                  <span className="font-semibold text-foreground">{words.length}</span> lemmas at the edge of your
                  territory. They have curated sentence IDs, but none are wired for cloze yet (missing or mismatched
                  sentence links, removed sentences, or language filters). A listed new-words session can&apos;t start
                  for this batch. Use general Build vocabulary for now, or fix links in the corpus pipeline.
                </>
              ) : (
                <>
                  Column {columnIndex + 1} on your heatmap is open with{" "}
                  <span className="font-semibold text-foreground">{words.length}</span> lemmas at the edge of your
                  territory. None of them have cloze-ready sentences yet, so a listed new-words session can&apos;t start
                  for this batch. Use general Build vocabulary for now, or try again after more sentences ship for these
                  ranks.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-xl border border-border/60 bg-background/70 backdrop-blur-sm px-3 py-2 max-h-36 overflow-y-auto">
            <ul className="space-y-1 text-sm">
              {words.slice(0, 24).map((w) => (
                <li key={w.wordId} className="flex justify-between gap-2 tabular-nums">
                  <span className="truncate font-medium text-foreground">{w.lemma}</span>
                  <span className="shrink-0 text-muted-foreground font-mono text-xs">#{w.rank.toLocaleString()}</span>
                </li>
              ))}
              {words.length > 24 ? (
                <li className="text-xs text-muted-foreground pt-1">+{words.length - 24} more in this batch</li>
              ) : null}
            </ul>
          </div>

          <p className="text-center text-xs text-muted-foreground">
            Pick a celebration style — we&apos;ll remember it on this device.
          </p>
          <div className="flex flex-wrap justify-center gap-1.5">
            {NEW_WORDS_INTRO_VARIANTS.map((v) => (
              <button
                key={v}
                type="button"
                disabled={busy}
                onClick={() => setVariantPersist(v)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  variant === v
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border/80 bg-background/80 text-muted-foreground hover:bg-accent",
                )}
              >
                {VARIANT_LABELS[v]}
              </button>
            ))}
          </div>
        </div>

        <DialogFooter className="border-t border-border/50 bg-background/50 p-4 sm:justify-center gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          <Button type="button" size="sm" disabled={busy || !canBeginPractice} onClick={() => void onBegin()}>
            {busy ? "Starting…" : "Let’s practice"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
