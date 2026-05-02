-- AlterEnum
ALTER TYPE "IngestionType" ADD VALUE 'CLOZE_GENERATION';

-- CreateTable
CREATE TABLE "generated_cloze" (
    "id" UUID NOT NULL,
    "languageId" UUID NOT NULL,
    "wordId" UUID NOT NULL,
    "sentence" TEXT NOT NULL,
    "cloze" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "alternatives" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "difficulty" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL,
    "sourceCandidates" JSONB,
    "selectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_cloze_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "generated_cloze_wordId_sortOrder_key" ON "generated_cloze"("wordId", "sortOrder");

-- CreateIndex
CREATE INDEX "generated_cloze_languageId_idx" ON "generated_cloze"("languageId");

-- CreateIndex
CREATE INDEX "generated_cloze_languageId_wordId_idx" ON "generated_cloze"("languageId", "wordId");

-- AddForeignKey
ALTER TABLE "generated_cloze" ADD CONSTRAINT "generated_cloze_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "language"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_cloze" ADD CONSTRAINT "generated_cloze_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "word"("id") ON DELETE CASCADE ON UPDATE CASCADE;
