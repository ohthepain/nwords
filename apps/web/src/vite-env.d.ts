/// <reference types="vite/client" />

declare const __GIT_HASH__: string

interface ImportMetaEnv {
	readonly GOOGLE_AUTH_ENABLED?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
