-- AlterEnum
ALTER TYPE "IngestionType" ADD VALUE 'WORD_FORMS';

-- CreateTable
CREATE TABLE "word_form" (
    "id" UUID NOT NULL,
    "languageId" UUID NOT NULL,
    "form" TEXT NOT NULL,
    "wordId" UUID NOT NULL,
    "tags" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "word_form_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "word_form_languageId_form_idx" ON "word_form"("languageId", "form");

-- CreateIndex
CREATE INDEX "word_form_wordId_idx" ON "word_form"("wordId");

-- CreateIndex
CREATE UNIQUE INDEX "word_form_languageId_form_wordId_key" ON "word_form"("languageId", "form", "wordId");

-- AddForeignKey
ALTER TABLE "word_form" ADD CONSTRAINT "word_form_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "language"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "word_form" ADD CONSTRAINT "word_form_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "word"("id") ON DELETE CASCADE ON UPDATE CASCADE;
