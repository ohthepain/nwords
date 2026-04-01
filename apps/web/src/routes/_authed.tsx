import { Outlet, createFileRoute, redirect, useMatches } from "@tanstack/react-router"
import { AuthedAppHeader } from "~/components/authed-app-header"
import { getAuthedLayoutData } from "~/lib/auth-session"
import { authedPageTitleForRouteId } from "~/lib/authed-page-title"

export const Route = createFileRoute("/_authed")({
	beforeLoad: async () => {
		const data = await getAuthedLayoutData()
		if (!data) {
			throw redirect({ to: "/auth/login" })
		}
		return data
	},
	component: AuthedLayout,
})

function AuthedLayout() {
	const { user, isAdmin, nativeLanguage } = Route.useRouteContext()

	const matches = useMatches()
	const leaf = matches.at(-1)
	const pageTitle = authedPageTitleForRouteId(leaf?.routeId)

	return (
		<div className="flex-1 flex flex-col min-h-0">
			<AuthedAppHeader
				pageTitle={pageTitle}
				user={{ id: user.id, name: user.name, email: user.email }}
				isAdmin={isAdmin}
				nativeLanguage={nativeLanguage ? { id: nativeLanguage.id, code: nativeLanguage.code } : null}
			/>
			<main className="flex-1 min-h-0 flex flex-col">
				<Outlet />
			</main>
		</div>
	)
}
