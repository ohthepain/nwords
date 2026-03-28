/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly GOOGLE_AUTH_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
