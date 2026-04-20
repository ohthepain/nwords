import { auth } from "@nwords/auth/server"
import { prisma } from "@nwords/db"
import { KNOWN_CONFIDENCE_THRESHOLD, KNOWN_MIN_TESTS } from "@nwords/shared"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { useState } from "react"
import { LanguagePairSelectRow } from "~/components/language-pair-select-row"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { Label } from "~/components/ui/label"
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select"
import { UI_STYLES, useThemeStore } from "~/stores/theme"

const getSettingsData = createServerFn({ method: "GET" }).handler(async () => {
	const request = getRequest()
	if (!request) return null
	const session = await auth.api.getSession({ headers: request.headers })
	if (!session?.user?.id) return null

	const [user, languages] = await Promise.all([
		prisma.user.findUnique({
			where: { id: session.user.id },
			select: {
				nativeLanguageId: true,
				targetLanguageId: true,
				languageProfiles: { select: { languageId: true, assumedRank: true } },
			},
		}),
		prisma.language.findMany({
			orderBy: { name: "asc" },
			select: { id: true, code: true, name: true, enabled: true },
		}),
	])

	const targetLanguageId = user?.targetLanguageId ?? null
	const rawProfiles = user?.languageProfiles ?? []

	const knownCounts = await Promise.all(
		rawProfiles.map((p) =>
			prisma.userWordKnowledge
				.count({
					where: {
						userId: session.user.id,
						confidence: { gte: KNOWN_CONFIDENCE_THRESHOLD },
						timesTested: { gte: KNOWN_MIN_TESTS },
						word: { languageId: p.languageId },
					},
				})
				.then((count) => ({
					languageId: p.languageId,
					assumedRank: p.assumedRank,
					knownCount: count,
				})),
		),
	)

	return {
		nativeLanguageId: user?.nativeLanguageId ?? null,
		targetLanguageId,
		languageProfiles: knownCounts,
		languages,
	}
})

const updateLanguages = createServerFn({ method: "POST" })
	.inputValidator((data: { nativeLanguageId: string; targetLanguageId: string }) => data)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) return { success: false }
		const session = await auth.api.getSession({ headers: request.headers })
		if (!session?.user?.id) return { success: false }

		if (data.nativeLanguageId === data.targetLanguageId) {
			return { success: false, error: "Languages must be different" }
		}

		await prisma.user.update({
			where: { id: session.user.id },
			data: {
				nativeLanguageId: data.nativeLanguageId,
				targetLanguageId: data.targetLanguageId,
			},
		})

		return { success: true }
	})

export const Route = createFileRoute("/_authed/settings")({
	loader: () => getSettingsData(),
	component: SettingsPage,
})

function SettingsPage() {
	const data = Route.useLoaderData()
	const navigate = useNavigate()
	const { uiStyle, setUiStyle } = useThemeStore()

	const [nativeId, setNativeId] = useState(data?.nativeLanguageId ?? "")
	const [targetId, setTargetId] = useState(data?.targetLanguageId ?? "")
	const [startBusy, _setStartBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	if (!data) return null

	const selectedProfile = data.languageProfiles.find((p) => p.languageId === targetId)
	const assumedRankRaw = selectedProfile?.assumedRank
	const assumedRankForSelectedTarget =
		assumedRankRaw != null && assumedRankRaw > 0 ? assumedRankRaw : null
	const knownCountForSelectedTarget = selectedProfile?.knownCount ?? null

	const allLanguages = data.languages
	const enabledLanguages = data.languages.filter((l) => l.enabled)

	async function autoSave(nativeLanguageId: string, targetLanguageId: string) {
		if (!nativeLanguageId || !targetLanguageId || nativeLanguageId === targetLanguageId) return
		setError(null)
		const result = await updateLanguages({ data: { nativeLanguageId, targetLanguageId } })
		if (!result.success) setError(result.error ?? "Failed to save")
	}

	function handleNativeChange(id: string) {
		setNativeId(id)
		void autoSave(id, targetId)
	}

	function handleTargetChange(id: string) {
		setTargetId(id)
		void autoSave(nativeId, id)
	}

	return (
		<div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Languages</CardTitle>
				</CardHeader>
				<CardContent className="space-y-5">
					<LanguagePairSelectRow
						nativeLabel="I speak"
						targetLabel="I want to study"
						nativeLanguages={allLanguages}
						targetLanguages={enabledLanguages}
						nativeValue={nativeId}
						targetValue={targetId}
						onNativeChange={handleNativeChange}
						onTargetChange={handleTargetChange}
						nativeSelectId="settings-native-lang"
						targetSelectId="settings-target-lang"
						measureBuild={{
							assumedRankForSelectedTarget,
							knownCountForSelectedTarget,
							actionBusy: startBusy,
							onMeasureOrBuildClick: () => {
								const rank =
									data.languageProfiles.find((p) => p.languageId === targetId)?.assumedRank ?? 0
								void navigate({
									to: "/practice",
									search: { vocabMode: rank > 0 ? "BUILD" : "ASSESSMENT" },
								})
							},
						}}
					/>

					{error && (
						<p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
							{error}
						</p>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">UI style</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="space-y-2">
						<Label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
							UI Style
						</Label>
						<Select value={uiStyle} onValueChange={(v) => setUiStyle(v as typeof uiStyle)}>
							<SelectTrigger className="h-10 max-w-xs">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{UI_STYLES.map((style) => (
									<SelectItem key={style} value={style}>
										{style.charAt(0).toUpperCase() + style.slice(1)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</CardContent>
			</Card>
		</div>
	)
}
