/**
 * Whether dev-only UI (toggle, heatmap grid, practice debug panel) may be used without an admin account.
 * True for `vite` dev server, or any build served from loopback (e.g. `vite preview` on localhost).
 */
export function isLocalDevEnvironment(): boolean {
	if (import.meta.env.DEV) return true
	if (typeof window === "undefined") return false
	const h = window.location.hostname
	return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1"
}
