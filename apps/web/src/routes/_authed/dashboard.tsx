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

	const [latestScore, recentScores, languageProfile, frustrationWordCount] = await Promise.all([
		prisma.scoreHistory.findFirst({
			where: { userId: user.id },
			orderBy: { recordedAt: "desc" },
		}),
		prisma.scoreHistory.findMany({
			where: { userId: user.id },
			orderBy: { recordedAt: "desc" },
			take: 10,
		}),
		user.targetLanguageId
			? prisma.userLanguageProfile.findUnique({
					where: {
						userId_languageId: {
							userId: user.id,
							languageId: user.targetLanguageId,
						},
					},
				})
			: null,
		// Count frustration words (tested >= 5 times, low confidence)
		prisma.userWordKnowledge.count({
			where: {
				userId: user.id,
				timesTested: { gte: 5 },
				confidence: { lt: 0.5 },
			},
		}),
	])

	return {
		user: {
			name: user.name,
			nativeLanguage: user.nativeLanguage,
			targetLanguage: user.targetLanguage,
			role: user.role,
		},
		assumedRank: languageProfile?.assumedRank ?? 0,
		frustrationWordCount,
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

	const hasAssumedRank = data.assumedRank > 0

	return (
		<div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
			{/* Header */}
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 justify-between">
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
							Assumed rank
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="text-4xl font-bold font-mono tracking-tight animate-count-up">
							{hasAssumedRank ? data.assumedRank.toLocaleString() : "—"}
						</div>
						<p className="text-xs text-muted-foreground mt-2">
							{hasAssumedRank ? "words assumed known" : "take an assessment to find out"}
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
							{cefrLevel ? CEFR_DESCRIPTIONS[cefrLevel] : "take an assessment to find out"}
						</p>
					</CardContent>
				</Card>
			</div>

			{/* No assumed rank: first-time CTA */}
			{!hasAssumedRank && (
				<Card className="border-dashed">
					<CardContent className="py-12 text-center">
						<p className="text-sm text-muted-foreground mb-4">
							Ready to find out your vocabulary level?
						</p>
						<Button asChild>
							<Link to="/practice" search={{ vocabMode: "ASSESSMENT" }}>
								Start your first test
							</Link>
						</Button>
					</CardContent>
				</Card>
			)}

			{/* Has assumed rank: show all 3 testing modes */}
			{hasAssumedRank && (
				<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
					<Card>
						<CardHeader className="pb-2">
							<CardTitle className="text-base">Measure</CardTitle>
						</CardHeader>
						<CardContent className="space-y-3">
							<p className="text-sm text-muted-foreground leading-relaxed">
								Re-assess your vocabulary level. Binary search finds your boundary — correct means
								you know it, wrong means you don&apos;t.
							</p>
							<Button asChild variant="outline" size="sm" className="w-full">
								<Link to="/practice" search={{ vocabMode: "ASSESSMENT" }}>
									Start assessment
								</Link>
							</Button>
						</CardContent>
					</Card>

					<Card>
						<CardHeader className="pb-2">
							<CardTitle className="text-base">Build</CardTitle>
						</CardHeader>
						<CardContent className="space-y-3">
							<p className="text-sm text-muted-foreground leading-relaxed">
								Expand your vocabulary above rank {data.assumedRank.toLocaleString()}. New words,
								shaky words, and the occasional confidence boost.
							</p>
							<Button asChild size="sm" className="w-full">
								<Link to="/practice" search={{ vocabMode: "BUILD" }}>
									Start building
								</Link>
							</Button>
						</CardContent>
					</Card>

					<Card>
						<CardHeader className="pb-2">
							<CardTitle className="text-base">Frustration words</CardTitle>
						</CardHeader>
						<CardContent className="space-y-3">
							<p className="text-sm text-muted-foreground leading-relaxed">
								{data.frustrationWordCount >= 5 ? (
									<>
										Attack your {data.frustrationWordCount} stubbornest{" "}
										{data.frustrationWordCount === 1 ? "word" : "words"}. Short bursts, repeat
										throughout the day.
									</>
								) : data.frustrationWordCount > 0 ? (
									<>
										Only {data.frustrationWordCount} frustration{" "}
										{data.frustrationWordCount === 1 ? "word" : "words"} so far — need at least 5 to
										start a drill.
									</>
								) : (
									<>
										No frustration words yet. Keep building your vocabulary and any trouble words
										will show up here.
									</>
								)}
							</p>
							<Button
								asChild={data.frustrationWordCount >= 5}
								variant="outline"
								size="sm"
								className="w-full"
								disabled={data.frustrationWordCount < 5}
							>
								{data.frustrationWordCount >= 5 ? (
									<Link to="/practice" search={{ vocabMode: "FRUSTRATION" }}>
										Drill frustration words
									</Link>
								) : (
									"Drill frustration words"
								)}
							</Button>
						</CardContent>
					</Card>
				</div>
			)}
		</div>
	)
}
