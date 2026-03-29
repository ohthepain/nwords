import { auth } from "@nwords/auth/server"
import { prisma } from "@nwords/db"
import { CEFR_DESCRIPTIONS, getCefrLevel } from "@nwords/shared"
import { Link, createFileRoute } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"

const getDashboardData = createServerFn({ method: "GET" }).handler(async () => {
	const request = getRequest()
	if (!request) return null
	const session = await auth.api.getSession({ headers: request.headers })
	if (!session?.user?.id) return null

	const user = await prisma.user.findUnique({
		where: { id: session.user.id },
		include: {
			nativeLanguage: true,
			targetLanguage: true,
		},
	})

	if (!user) return null

	const latestScore = await prisma.scoreHistory.findFirst({
		where: { userId: user.id },
		orderBy: { recordedAt: "desc" },
	})

	const recentScores = await prisma.scoreHistory.findMany({
		where: { userId: user.id },
		orderBy: { recordedAt: "desc" },
		take: 10,
	})

	return {
		user: {
			name: user.name,
			nativeLanguage: user.nativeLanguage,
			targetLanguage: user.targetLanguage,
			role: user.role,
		},
		latestScore: latestScore
			? {
					actualScore: latestScore.actualScore,
					targetScore: latestScore.targetScore,
					cefrLevel: latestScore.cefrLevel,
				}
			: null,
		recentScores: recentScores.map((s) => ({
			actualScore: s.actualScore,
			targetScore: s.targetScore,
			recordedAt: s.recordedAt.toISOString(),
		})),
	}
})

export const Route = createFileRoute("/_authed/dashboard")({
	loader: () => getDashboardData(),
	component: DashboardPage,
})

function DashboardPage() {
	const data = Route.useLoaderData()

	if (!data) {
		return <div className="p-6 text-muted-foreground">Loading...</div>
	}

	const needsSetup = !data.user.nativeLanguage || !data.user.targetLanguage

	if (needsSetup) {
		return (
			<div className="flex-1 flex items-center justify-center px-6">
				<div className="max-w-md text-center py-20">
					<div className="size-16 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-6">
						<span className="text-2xl font-bold font-mono text-muted-foreground">?</span>
					</div>
					<h1 className="text-2xl font-bold mb-3">Welcome, {data.user.name}</h1>
					<p className="text-muted-foreground mb-8 leading-relaxed">
						Before you start testing, select your native language and the language you want to
						study.
					</p>
					<Button asChild size="lg">
						<Link to="/settings">Set up languages</Link>
					</Button>
				</div>
			</div>
		)
	}

	const cefrLevel = data.latestScore ? getCefrLevel(data.latestScore.actualScore) : null

	const hasScores = data.latestScore !== null

	return (
		<div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
			{/* Header */}
			<div>
				<p className="text-sm text-muted-foreground flex items-center gap-2">
					<span>{data.user.nativeLanguage?.name}</span>
					<span className="text-xs font-mono opacity-50">→</span>
					<span className="font-medium text-foreground">{data.user.targetLanguage?.name}</span>
				</p>
			</div>

			{/* Stats grid */}
			<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
				<Card className="stat-card">
					<CardHeader className="pb-2">
						<CardTitle className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
							Vocabulary size
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="text-4xl font-bold font-mono tracking-tight animate-count-up">
							{data.latestScore?.actualScore?.toLocaleString() ?? "—"}
						</div>
						<p className="text-xs text-muted-foreground mt-2">confirmed words</p>
					</CardContent>
				</Card>

				<Card className="stat-card">
					<CardHeader className="pb-2">
						<CardTitle className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
							Estimated ceiling
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="text-4xl font-bold font-mono tracking-tight animate-count-up">
							{data.latestScore?.targetScore?.toLocaleString() ?? "—"}
						</div>
						<p className="text-xs text-muted-foreground mt-2">
							{hasScores ? (
								<>
									<span className="text-brand font-mono font-medium">
										{(
											(data.latestScore?.targetScore ?? 0) - (data.latestScore?.actualScore ?? 0)
										).toLocaleString()}
									</span>{" "}
									words to verify
								</>
							) : (
								"take a test to find out"
							)}
						</p>
					</CardContent>
				</Card>

				<Card className="stat-card">
					<CardHeader className="pb-2">
						<CardTitle className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
							CEFR Level
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="text-4xl font-bold font-mono tracking-tight animate-count-up">
							{cefrLevel ?? "—"}
						</div>
						<p className="text-xs text-muted-foreground mt-2">
							{cefrLevel ? CEFR_DESCRIPTIONS[cefrLevel] : "take a test to find out"}
						</p>
					</CardContent>
				</Card>
			</div>

			{/* Empty state CTA */}
			{!hasScores && (
				<Card className="border-dashed">
					<CardContent className="py-12 text-center">
						<p className="text-sm text-muted-foreground mb-4">
							Ready to find out your vocabulary level?
						</p>
						<Button>Start your first test</Button>
					</CardContent>
				</Card>
			)}
		</div>
	)
}
