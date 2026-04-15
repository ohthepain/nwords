-- Build-mode vocabulary selection overrides (full merged object or partial; API merges with defaults).
ALTER TABLE "app_settings" ADD COLUMN "vocab_build_settings" JSONB;
