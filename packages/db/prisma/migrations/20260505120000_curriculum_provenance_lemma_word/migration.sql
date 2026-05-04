-- Enum: HermitDave-append provenance (shared with Word.curriculumSource).
ALTER TYPE "CurriculumSource" ADD VALUE 'HERMIT_DAVE';

-- Language common lemmas: source of each row (default matches historical "from common-words / admin" list).
ALTER TABLE "language_common_lemma" ADD COLUMN "curriculumSource" "CurriculumSource" NOT NULL DEFAULT 'COMMON';

-- Legacy COMMON_CURRICULUM_KAIKKI output was stored as COMMON; those rows are Kaikki-expanded curriculum.
UPDATE "word" SET "curriculumSource" = 'KAIKKI' WHERE "curriculumSource" = 'COMMON';
