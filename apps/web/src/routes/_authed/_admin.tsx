import { auth } from "@nwords/auth/server"
import { prisma } from "@nwords/db"
import { Link, Outlet, createFileRoute, redirect } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { ChevronLeft } from "lucide-react"

const checkAdmin = createServerFn({ method: "GET" }).handler(async () => {
	const request = getRequest()
	if (!request) return false
	const session = await auth.api.getSession({ headers: request.headers })
	if (!session?.user?.id) return false
	const user = await prisma.user.findUnique({
		where: { id: session.user.id },
		select: { role: true },
	})
	return user?.role === "ADMIN"
})

export const Route = createFileRoute("/_authed/_admin")({
	beforeLoad: async () => {
		const isAdmin = await checkAdmin()
		if (!isAdmin) {
			throw redirect({ to: "/dashboard" })
		}
	},
	component: AdminLayout,
})

function AdminLayout() {
	return (
		<div className="flex-1 flex flex-col min-h-0">
			<header className="shrink-0 border-b border-border bg-muted/30 px-6 py-3 flex items-center justify-between gap-4">
				<Link
					to="/dashboard"
					className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
				>
					<ChevronLeft className="size-4 shrink-0" />
					Dashboard
				</Link>
				<Link
					to="/admin"
					className="text-sm text-muted-foreground hover:text-foreground transition-colors"
				>
					Admin home
				</Link>
			</header>
			<div className="flex-1 overflow-auto">
				<Outlet />
			</div>
		</div>
	)
}
