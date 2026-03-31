-- CreateEnum
CREATE TYPE "ClozeIssueStatus" AS ENUM ('PENDING', 'REMOVE_CANDIDATE', 'CLUE_CORRECTED', 'DISMISSED');

-- CreateTable
CREATE TABLE "cloze_issue_report" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reporterUserId" UUID,
    "nativeLanguageId" UUID NOT NULL,
    "targetLanguageId" UUID NOT NULL,
    "wordId" UUID NOT NULL,
    "targetSentenceId" UUID,
    "hintSentenceId" UUID,
    "targetSentenceText" TEXT NOT NULL,
    "promptText" TEXT NOT NULL,
    "hintText" TEXT NOT NULL,
    "hintSource" TEXT NOT NULL,
    "inlineHint" TEXT,
    "wordLemma" TEXT NOT NULL,
    "status" "ClozeIssueStatus" NOT NULL DEFAULT 'PENDING',
    "adminCorrectClue" TEXT,
    "adminNote" TEXT,

    CONSTRAINT "cloze_issue_report_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "cloze_issue_report" ADD CONSTRAINT "cloze_issue_report_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cloze_issue_report" ADD CONSTRAINT "cloze_issue_report_nativeLanguageId_fkey" FOREIGN KEY ("nativeLanguageId") REFERENCES "language"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cloze_issue_report" ADD CONSTRAINT "cloze_issue_report_targetLanguageId_fkey" FOREIGN KEY ("targetLanguageId") REFERENCES "language"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cloze_issue_report" ADD CONSTRAINT "cloze_issue_report_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "word"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "cloze_issue_report_targetLanguageId_status_idx" ON "cloze_issue_report"("targetLanguageId", "status");

CREATE INDEX "cloze_issue_report_createdAt_idx" ON "cloze_issue_report"("createdAt");
