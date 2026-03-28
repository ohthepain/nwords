import { auth } from "@nwords/auth/server"
import { prisma } from "@nwords/db"
import { Link, Outlet, createFileRoute, redirect } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"

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
		<div className="flex-1 flex">
			<aside className="w-52 border-r border-border/50 bg-muted/30">
				<div className="p-4 space-y-1">
					<div className="text-[10px] font-mono text-muted-foreground uppercase tracking-[0.15em] mb-4 px-2 flex items-center gap-2">
						<span className="size-1.5 rounded-full bg-brand" />
						Admin
					</div>
					<AdminNavLink to="/admin/languages">Languages</AdminNavLink>
					<AdminNavLink to="/admin/vocabulary">Vocabulary</AdminNavLink>
					<AdminNavLink to="/admin/sentences">Sentences</AdminNavLink>
					<AdminNavLink to="/admin/jobs">Jobs</AdminNavLink>
					<AdminNavLink to="/admin/users">Users</AdminNavLink>
				</div>
			</aside>
			<div className="flex-1 overflow-auto">
				<Outlet />
			</div>
		</div>
	)
}

function AdminNavLink({ to, children }: { to: string; children: React.ReactNode }) {
	return (
		<Link
			to={to}
			className="block text-sm px-2 py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors [&.active]:text-foreground [&.active]:bg-accent [&.active]:font-medium"
		>
			{children}
		</Link>
	)
}
