-- CreateEnum
CREATE TYPE "SynonymQuality" AS ENUM ('GOOD', 'BAD');

-- CreateTable
CREATE TABLE "word_synonym_pair" (
    "id" UUID NOT NULL,
    "languageId" UUID NOT NULL,
    "wordIdLow" UUID NOT NULL,
    "wordIdHigh" UUID NOT NULL,
    "quality" "SynonymQuality" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "word_synonym_pair_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "word_synonym_pair_languageId_wordIdLow_wordIdHigh_key" ON "word_synonym_pair"("languageId", "wordIdLow", "wordIdHigh");

CREATE INDEX "word_synonym_pair_languageId_wordIdLow_idx" ON "word_synonym_pair"("languageId", "wordIdLow");

CREATE INDEX "word_synonym_pair_languageId_wordIdHigh_idx" ON "word_synonym_pair"("languageId", "wordIdHigh");

-- AddForeignKey
ALTER TABLE "word_synonym_pair" ADD CONSTRAINT "word_synonym_pair_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "language"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "word_synonym_pair" ADD CONSTRAINT "word_synonym_pair_wordIdLow_fkey" FOREIGN KEY ("wordIdLow") REFERENCES "word"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "word_synonym_pair" ADD CONSTRAINT "word_synonym_pair_wordIdHigh_fkey" FOREIGN KEY ("wordIdHigh") REFERENCES "word"("id") ON DELETE CASCADE ON UPDATE CASCADE;
