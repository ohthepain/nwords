-- AlterTable
ALTER TABLE "test_session" ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "test_session" ADD COLUMN "nativeLanguageId" UUID,
ADD COLUMN "targetLanguageId" UUID;

-- AddForeignKey
ALTER TABLE "test_session" ADD CONSTRAINT "test_session_nativeLanguageId_fkey" FOREIGN KEY ("nativeLanguageId") REFERENCES "language"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "test_session" ADD CONSTRAINT "test_session_targetLanguageId_fkey" FOREIGN KEY ("targetLanguageId") REFERENCES "language"("id") ON DELETE SET NULL ON UPDATE CASCADE;
