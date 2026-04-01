-- CreateTable
CREATE TABLE "pos_mismatch_message" (
    "id" UUID NOT NULL,
    "languageId" UUID NOT NULL,
    "guessPos" "PartOfSpeech" NOT NULL,
    "targetPos" "PartOfSpeech" NOT NULL,
    "message" TEXT NOT NULL,

    CONSTRAINT "pos_mismatch_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pos_mismatch_message_languageId_guessPos_targetPos_key" ON "pos_mismatch_message"("languageId", "guessPos", "targetPos");

-- AddForeignKey
ALTER TABLE "pos_mismatch_message" ADD CONSTRAINT "pos_mismatch_message_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "language"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
