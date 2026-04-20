-- Better Auth anonymous plugin + guest learner linking
ALTER TABLE "user" ADD COLUMN "isAnonymous" BOOLEAN NOT NULL DEFAULT false;
