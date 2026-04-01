/** Leaf route ids (see `FileRouteTypes["id"]` in routeTree.gen). */
const ROUTE_PAGE_TITLE: Record<string, string> = {
	"/_authed/dashboard": "Dashboard",
	"/_authed/settings": "Settings",
	"/_authed/_admin/admin/": "Admin",
	"/_authed/_admin/admin/settings": "Site settings",
	"/_authed/_admin/admin/languages": "Languages",
	"/_authed/_admin/admin/jobs": "Jobs",
	"/_authed/_admin/admin/words": "Words",
	"/_authed/_admin/admin/sentences": "Sentences",
	"/_authed/_admin/admin/cloze-reports": "Cloze reports",
}

export function authedPageTitleForRouteId(routeId: string | undefined): string {
	if (!routeId) return "nwords"
	return ROUTE_PAGE_TITLE[routeId] ?? "nwords"
}
