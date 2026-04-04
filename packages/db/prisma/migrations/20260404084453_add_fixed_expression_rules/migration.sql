-- AlterEnum
ALTER TYPE "IngestionType" ADD VALUE 'FIXED_EXPRESSIONS';

-- CreateTable
CREATE TABLE "fixed_expression_rule" (
    "id" UUID NOT NULL,
    "languageId" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "required" TEXT NOT NULL,
    "invalid" TEXT[],
    "expression" TEXT NOT NULL,
    "meaning" TEXT NOT NULL,

    CONSTRAINT "fixed_expression_rule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fixed_expression_rule_languageId_idx" ON "fixed_expression_rule"("languageId");

-- CreateIndex
CREATE UNIQUE INDEX "fixed_expression_rule_languageId_trigger_required_key" ON "fixed_expression_rule"("languageId", "trigger", "required");

-- AddForeignKey
ALTER TABLE "fixed_expression_rule" ADD CONSTRAINT "fixed_expression_rule_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "language"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
