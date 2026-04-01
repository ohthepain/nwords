-- Singleton row id: "default" (created on first read via API upsert if missing)
CREATE TABLE "app_settings" (
    "id" TEXT NOT NULL,
    "showHints" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);
