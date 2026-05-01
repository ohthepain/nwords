-- CreateTable
CREATE TABLE "language_common_lemma" (
    "id" UUID NOT NULL,
    "languageId" UUID NOT NULL,
    "lemma" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "language_common_lemma_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "language_common_lemma_languageId_sortOrder_idx" ON "language_common_lemma"("languageId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "language_common_lemma_languageId_lemma_key" ON "language_common_lemma"("languageId", "lemma");

-- AddForeignKey
ALTER TABLE "language_common_lemma" ADD CONSTRAINT "language_common_lemma_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "language"("id") ON DELETE CASCADE ON UPDATE CASCADE;
