-- CreateTable
CREATE TABLE "generated_cloze_translation" (
    "id" UUID NOT NULL,
    "generatedClozeId" UUID NOT NULL,
    "languageId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "aiProvider" TEXT,
    "aiModel" TEXT,
    "sourceSentenceHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generated_cloze_translation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "generated_cloze_translation_generatedClozeId_languageId_key" ON "generated_cloze_translation"("generatedClozeId", "languageId");

-- CreateIndex
CREATE INDEX "generated_cloze_translation_languageId_idx" ON "generated_cloze_translation"("languageId");

-- AddForeignKey
ALTER TABLE "generated_cloze_translation" ADD CONSTRAINT "generated_cloze_translation_generatedClozeId_fkey" FOREIGN KEY ("generatedClozeId") REFERENCES "generated_cloze"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_cloze_translation" ADD CONSTRAINT "generated_cloze_translation_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "language"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
