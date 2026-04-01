-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "PartOfSpeech" AS ENUM ('NOUN', 'VERB', 'ADJECTIVE', 'ADVERB');

-- CreateEnum
CREATE TYPE "CefrLevel" AS ENUM ('A1', 'A2', 'B1', 'B2', 'C1', 'C2');

-- CreateEnum
CREATE TYPE "TestMode" AS ENUM ('MULTIPLE_CHOICE', 'TRANSLATION', 'VOICE', 'MIXED');

-- CreateEnum
CREATE TYPE "VocabMode" AS ENUM ('ASSESSMENT', 'BUILD', 'FRUSTRATION');

-- CreateEnum
CREATE TYPE "AnswerType" AS ENUM ('MULTIPLE_CHOICE', 'TRANSLATION_TYPED', 'VOICE_TRANSCRIPTION');

-- CreateEnum
CREATE TYPE "ClozeIssueStatus" AS ENUM ('PENDING', 'REMOVE_CANDIDATE', 'CLUE_CORRECTED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "IngestionType" AS ENUM ('KAIKKI_WORDS', 'FREQUENCY_LIST', 'TATOEBA_SENTENCES', 'WORD_FORMS', 'AUDIO_FILES');

-- CreateEnum
CREATE TYPE "IngestionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nativeLanguageId" UUID,
    "targetLanguageId" UUID,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" UUID NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" UUID,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "language" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "code3" TEXT,
    "name" TEXT NOT NULL,
    "kaikkiDictionaryName" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "language_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "word" (
    "id" UUID NOT NULL,
    "languageId" UUID NOT NULL,
    "lemma" TEXT NOT NULL,
    "pos" "PartOfSpeech" NOT NULL,
    "rank" INTEGER NOT NULL,
    "definitions" JSONB NOT NULL,
    "isOffensive" BOOLEAN NOT NULL DEFAULT false,
    "cefrLevel" "CefrLevel",
    "testSentenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "word_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "word_form" (
    "id" UUID NOT NULL,
    "languageId" UUID NOT NULL,
    "form" TEXT NOT NULL,
    "wordId" UUID NOT NULL,
    "tags" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "word_form_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "frequency_list" (
    "id" UUID NOT NULL,
    "languageId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "version" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "frequency_list_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sentence" (
    "id" UUID NOT NULL,
    "tatoebaId" INTEGER,
    "languageId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "hasAudio" BOOLEAN NOT NULL DEFAULT false,
    "audioS3Key" TEXT,
    "testQualityScore" DOUBLE PRECISION,
    "isTestCandidate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sentence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sentence_translation" (
    "id" UUID NOT NULL,
    "originalSentenceId" UUID NOT NULL,
    "translatedSentenceId" UUID NOT NULL,

    CONSTRAINT "sentence_translation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sentence_word" (
    "id" UUID NOT NULL,
    "sentenceId" UUID NOT NULL,
    "wordId" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "sentence_word_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_language_profile" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "languageId" UUID NOT NULL,
    "assumedRank" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_language_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_word_knowledge" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "wordId" UUID NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "timesTested" INTEGER NOT NULL DEFAULT 0,
    "timesCorrect" INTEGER NOT NULL DEFAULT 0,
    "lastTestedAt" TIMESTAMP(3),
    "lastCorrect" BOOLEAN NOT NULL DEFAULT false,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_word_knowledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "score_history" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "actualScore" INTEGER NOT NULL,
    "targetScore" INTEGER NOT NULL,
    "cefrLevel" "CefrLevel",
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "score_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_session" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "nativeLanguageId" UUID,
    "targetLanguageId" UUID,
    "mode" "TestMode" NOT NULL,
    "vocabMode" "VocabMode" NOT NULL DEFAULT 'BUILD',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "wordsTestedCount" INTEGER NOT NULL DEFAULT 0,
    "wordsCorrectCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "test_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_answer" (
    "id" UUID NOT NULL,
    "testSessionId" UUID NOT NULL,
    "wordId" UUID NOT NULL,
    "sentenceId" UUID,
    "answerType" "AnswerType" NOT NULL,
    "userAnswer" TEXT,
    "correct" BOOLEAN NOT NULL,
    "wasTypo" BOOLEAN NOT NULL DEFAULT false,
    "timeTakenMs" INTEGER,
    "answeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_answer_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "ingestion_job" (
    "id" UUID NOT NULL,
    "type" "IngestionType" NOT NULL,
    "languageId" UUID NOT NULL,
    "status" "IngestionStatus" NOT NULL DEFAULT 'PENDING',
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "processedItems" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "ingestion_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE UNIQUE INDEX "language_code_key" ON "language"("code");

-- CreateIndex
CREATE INDEX "word_languageId_rank_idx" ON "word"("languageId", "rank");

-- CreateIndex
CREATE INDEX "word_languageId_cefrLevel_idx" ON "word"("languageId", "cefrLevel");

-- CreateIndex
CREATE UNIQUE INDEX "word_languageId_lemma_pos_key" ON "word"("languageId", "lemma", "pos");

-- CreateIndex
CREATE INDEX "word_form_languageId_form_idx" ON "word_form"("languageId", "form");

-- CreateIndex
CREATE INDEX "word_form_wordId_idx" ON "word_form"("wordId");

-- CreateIndex
CREATE UNIQUE INDEX "word_form_languageId_form_wordId_key" ON "word_form"("languageId", "form", "wordId");

-- CreateIndex
CREATE UNIQUE INDEX "frequency_list_languageId_source_key" ON "frequency_list"("languageId", "source");

-- CreateIndex
CREATE UNIQUE INDEX "sentence_tatoebaId_key" ON "sentence"("tatoebaId");

-- CreateIndex
CREATE INDEX "sentence_languageId_idx" ON "sentence"("languageId");

-- CreateIndex
CREATE INDEX "sentence_languageId_testQualityScore_idx" ON "sentence"("languageId", "testQualityScore");

-- CreateIndex
CREATE UNIQUE INDEX "sentence_translation_originalSentenceId_translatedSentenceI_key" ON "sentence_translation"("originalSentenceId", "translatedSentenceId");

-- CreateIndex
CREATE INDEX "sentence_word_wordId_idx" ON "sentence_word"("wordId");

-- CreateIndex
CREATE UNIQUE INDEX "sentence_word_sentenceId_wordId_key" ON "sentence_word"("sentenceId", "wordId");

-- CreateIndex
CREATE UNIQUE INDEX "user_language_profile_userId_languageId_key" ON "user_language_profile"("userId", "languageId");

-- CreateIndex
CREATE INDEX "user_word_knowledge_userId_confidence_idx" ON "user_word_knowledge"("userId", "confidence");

-- CreateIndex
CREATE UNIQUE INDEX "user_word_knowledge_userId_wordId_key" ON "user_word_knowledge"("userId", "wordId");

-- CreateIndex
CREATE INDEX "score_history_userId_recordedAt_idx" ON "score_history"("userId", "recordedAt");

-- CreateIndex
CREATE INDEX "test_session_userId_startedAt_idx" ON "test_session"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "test_answer_testSessionId_idx" ON "test_answer"("testSessionId");

-- CreateIndex
CREATE INDEX "cloze_issue_report_targetLanguageId_status_idx" ON "cloze_issue_report"("targetLanguageId", "status");

-- CreateIndex
CREATE INDEX "cloze_issue_report_createdAt_idx" ON "cloze_issue_report"("createdAt");

-- CreateIndex
CREATE INDEX "ingestion_job_status_idx" ON "ingestion_job"("status");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_nativeLanguageId_fkey" FOREIGN KEY ("nativeLanguageId") REFERENCES "language"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_targetLanguageId_fkey" FOREIGN KEY ("targetLanguageId") REFERENCES "language"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification" ADD CONSTRAINT "verification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "word" ADD CONSTRAINT "word_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "language"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "word_form" ADD CONSTRAINT "word_form_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "language"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "word_form" ADD CONSTRAINT "word_form_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "word"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "frequency_list" ADD CONSTRAINT "frequency_list_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "language"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sentence" ADD CONSTRAINT "sentence_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "language"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sentence_translation" ADD CONSTRAINT "sentence_translation_originalSentenceId_fkey" FOREIGN KEY ("originalSentenceId") REFERENCES "sentence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sentence_translation" ADD CONSTRAINT "sentence_translation_translatedSentenceId_fkey" FOREIGN KEY ("translatedSentenceId") REFERENCES "sentence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sentence_word" ADD CONSTRAINT "sentence_word_sentenceId_fkey" FOREIGN KEY ("sentenceId") REFERENCES "sentence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sentence_word" ADD CONSTRAINT "sentence_word_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "word"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_language_profile" ADD CONSTRAINT "user_language_profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_language_profile" ADD CONSTRAINT "user_language_profile_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "language"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_word_knowledge" ADD CONSTRAINT "user_word_knowledge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_word_knowledge" ADD CONSTRAINT "user_word_knowledge_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "word"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_history" ADD CONSTRAINT "score_history_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_session" ADD CONSTRAINT "test_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_session" ADD CONSTRAINT "test_session_nativeLanguageId_fkey" FOREIGN KEY ("nativeLanguageId") REFERENCES "language"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_session" ADD CONSTRAINT "test_session_targetLanguageId_fkey" FOREIGN KEY ("targetLanguageId") REFERENCES "language"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_answer" ADD CONSTRAINT "test_answer_testSessionId_fkey" FOREIGN KEY ("testSessionId") REFERENCES "test_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloze_issue_report" ADD CONSTRAINT "cloze_issue_report_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloze_issue_report" ADD CONSTRAINT "cloze_issue_report_nativeLanguageId_fkey" FOREIGN KEY ("nativeLanguageId") REFERENCES "language"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloze_issue_report" ADD CONSTRAINT "cloze_issue_report_targetLanguageId_fkey" FOREIGN KEY ("targetLanguageId") REFERENCES "language"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloze_issue_report" ADD CONSTRAINT "cloze_issue_report_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "word"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
