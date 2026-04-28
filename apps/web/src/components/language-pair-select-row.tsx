import { ArrowRight } from "lucide-react";
import { LanguageSelect, type LanguageSelectOption } from "~/components/language-select";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";

const EMPTY_TARGET_LANGUAGES_HINT = "Languages are enabled by admins once vocabulary data has been imported.";

export type LanguagePairMeasureBuildProps = {
  /** Non-null means the user has completed an assessment for this language. */
  assumedRankForSelectedTarget: number | null;
  /** Words with confidence >= threshold for this language; null = no profile yet. */
  knownCountForSelectedTarget: number | null;
  actionBusy?: boolean;
  actionBusyLabel?: string;
  onMeasureOrBuildClick: () => void | Promise<void>;
};

export type LanguagePairSelectRowProps = {
  nativeLabel: string;
  targetLabel: string;
  nativeLanguages: LanguageSelectOption[];
  targetLanguages: LanguageSelectOption[];
  nativeValue: string;
  targetValue: string;
  onNativeChange: (languageId: string) => void;
  onTargetChange: (languageId: string) => void;
  nativeSelectId?: string;
  targetSelectId?: string;
  /** Optional status line + primary CTA (measure vs build) for the selected target language. */
  measureBuild?: LanguagePairMeasureBuildProps | null;
};

function pairIsValid(nativeId: string, targetId: string): boolean {
  return Boolean(nativeId && targetId && nativeId !== targetId);
}

/** Two flag language pickers in one row (settings layout): native → target. */
export function LanguagePairSelectRow({
  nativeLabel,
  targetLabel,
  nativeLanguages,
  targetLanguages,
  nativeValue,
  targetValue,
  onNativeChange,
  onTargetChange,
  nativeSelectId,
  targetSelectId,
  measureBuild,
}: LanguagePairSelectRowProps) {
  const validPair = pairIsValid(nativeValue, targetValue);
  const hasMeasured = measureBuild != null && (measureBuild.assumedRankForSelectedTarget ?? 0) > 0;
  const _knownCount = measureBuild?.knownCountForSelectedTarget ?? null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-2 flex-1 min-w-[160px]">
          <Label
            htmlFor={nativeSelectId}
            className="text-base font-semibold font-mono text-foreground uppercase tracking-wider text-center block w-full"
          >
            {nativeLabel}
          </Label>
          <LanguageSelect
            id={nativeSelectId}
            languages={nativeLanguages}
            value={nativeValue}
            onValueChange={onNativeChange}
          />
        </div>

        <ArrowRight className="size-4 text-foreground shrink-0 mb-3" aria-hidden />

        <div className="space-y-2 flex-1 min-w-[160px]">
          <Label
            htmlFor={targetSelectId}
            className="text-base font-semibold font-mono text-foreground uppercase tracking-wider text-center block w-full"
          >
            {targetLabel}
          </Label>
          <LanguageSelect
            id={targetSelectId}
            languages={targetLanguages}
            value={targetValue}
            onValueChange={onTargetChange}
            emptyListMessage="No languages available yet"
          />
        </div>
      </div>

      {targetLanguages.length === 0 ? (
        <p className="text-xs text-foreground bg-muted rounded-md px-3 py-2">{EMPTY_TARGET_LANGUAGES_HINT}</p>
      ) : null}

      {measureBuild && targetValue ? (
        <div className="flex justify-center py-8">
          <Button
            type="button"
            className="w-full sm:w-auto gap-2"
            disabled={!validPair || measureBuild.actionBusy}
            onClick={() => void measureBuild.onMeasureOrBuildClick()}
          >
            {measureBuild.actionBusy
              ? (measureBuild.actionBusyLabel ?? "Loading…")
              : hasMeasured
                ? "Start building"
                : "Start measuring"}
            <ArrowRight className="size-4 shrink-0" aria-hidden />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
