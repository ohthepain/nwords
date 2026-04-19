import { updateConfidence } from "@nwords/shared"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useRef, useState } from "react"
import { AuthedAppHeader } from "~/components/authed-app-header"
import { AppHeaderBrand } from "~/components/header"
import { NewWordsIntroDialog } from "~/components/new-words-intro-dialog"
import { ThemeToggleButton } from "~/components/theme-toggle-button"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { type TerritoryColumnAdvancedPayload, VocabGraph } from "~/components/vocab-graph"
import { WordDetailDialog } from "~/components/word-detail-dialog"
import {
	type WordPanelKnowledge,
	type WordPanelWord,
	getWordPanelData,
} from "~/lib/get-word-panel-data-server-fn"
import { type WordSentence, getWordSentences } from "~/lib/get-word-sentences-server-fn"
import {
	MIN_TERRITORY_COLUMN_INTRO_LEMMAS,
	analyzeBuildPracticeColumn,
} from "~/lib/vocab-graph-column-utils"
import { useDevStore } from "~/stores/dev"
type UserMe = {
	id: string
	name: string
	email: string | null
	role: string
	nativeLanguage: { id: string; name: string; code: string } | null
	targetLanguage: { id: string; name: string; code: string } | null
}

type LanguageOption = { id: string; name: string; code: string }

type VocabMode = "ASSESSMENT" | "BUILD" | "FRUSTRATION" | "NEWWORDS"

type DevSelectionPanelTab = "band" | "intros" | "working"

type DevSelection = {
	vocabMode: VocabMode
	kind: string
	panelTab: DevSelectionPanelTab | null
	summary: string
	primaryBucket?: "new" | "shaky" | "mood"
	bucketOrder?: ("new" | "shaky" | "mood")[]
	strategyOrder?: string[]
}

type NewWordsBandIntroOffer = {
	kind: "working_set_thin" | "intro_backlog"
	wordIds: string[]
	words: { wordId: string; lemma: string; rank: number }[]
	practiceWordIds: string[]
	workingSetCount: number
	workingSetTarget: number
	introBacklogCount: number
}

type NextQuestion = {
	wordId: string
	lemma: string
	rank: number
	targetSentenceId: string
	promptText: string
	targetSentenceText: string
	hintText: string
	hintSentenceId: string | null
	hintSource: "parallel" | "definition"
	/** Target word translated to native language via English-gloss pivot (null if unavailable). */
	inlineHint: string | null
	answerType: "TRANSLATION_TYPED"
	sessionMode: string
	vocabMode?: VocabMode
	devSelection?: DevSelection
	newWordsBandIntroOffer?: NewWordsBandIntroOffer | null
}

type UpcomingWord = {
	wordId: string
	lemma: string
	rank: number
	testedInSession: boolean
	hasSentences: boolean
	confidence: number
	timesTested: number
	streak: number
	lastTestedAt: string | null
}

type DevNextPickPreview = {
	kind: string
	panelTab: DevSelectionPanelTab | null
	summary: string
	strategyPercents: { reinforce: number; introduce: number; bandWalk: number }
}

type UpcomingData = {
	vocabMode?: VocabMode
	questionNumber: number
	activeBand: UpcomingWord[]
	workingSet: UpcomingWord[]
	intros: UpcomingWord[]
	/** The word currently on screen, surfaced so the dev panel can always show it even if it doesn't match any list's filter. */
	current: UpcomingWord | null
	/** ISO timestamp when the server built this response — lets the refresh button show visible proof that data was refetched. */
	generatedAt: string
	bandLemmaCount: number
	clozableInBand: number
	workingSetCount: number
	workingSetThin: boolean
	/** True when Build will attach `newWordsBandIntroOffer` / skip auto-intros (working set below target). */
	introChunkGateActive: boolean
	devNextPickAfterSubmit: {
		questionNumber: number
		ifLastAnswerCorrect: DevNextPickPreview
		ifLastAnswerWrong: DevNextPickPreview
		previewsDiffer: boolean
	} | null
}

const VOCAB_MODE_LABELS: Record<VocabMode, string> = {
	ASSESSMENT: "Assessment",
	BUILD: "Build vocabulary",
	FRUSTRATION: "Frustration words",
	NEWWORDS: "New words (listed)",
}

type PracticeSearch = {
	vocabMode: VocabMode
	sentenceId?: string
	wordId?: string
}

/** Distinguishes dismiss keys; dialog maps `working_set_thin` to the same copy as `territory_column`. */
type NewWordsIntroPayloadKind = "territory_column" | "working_set_thin" | "intro_backlog"

/** Intro dialog state: `wordIds`/`words` are the column batch; session uses `practiceWordIds` only. */
type NewWordsColumnIntroPayload = TerritoryColumnAdvancedPayload & {
	/** Some column lemmas have curated sentence IDs but none pass the cloze join (links / sentence rows). */
	showCuratedUnlinkedCopy?: boolean
	introKind?: NewWordsIntroPayloadKind
	introBacklogCount?: number
}

export const Route = createFileRoute("/practice")({
	component: PracticePage,
	validateSearch: (search: Record<string, unknown>): PracticeSearch => ({
		vocabMode: (["ASSESSMENT", "BUILD", "FRUSTRATION", "NEWWORDS"].includes(
			search.vocabMode as string,
		)
			? search.vocabMode
			: "BUILD") as VocabMode,
		sentenceId:
			typeof search.sentenceId === "string" && search.sentenceId.trim()
				? search.sentenceId.trim()
				: undefined,
		wordId:
			typeof search.wordId === "string" && search.wordId.trim() ? search.wordId.trim() : undefined,
	}),
	head: () => ({
		meta: [{ title: "Practice — nwords.live" }],
	}),
})

function normalizeAnswer(s: string): string {
	return s.trim().toLowerCase()
}

function clozeQuestionReportKey(q: NextQuestion): string {
	return `${q.wordId}:${q.targetSentenceId}`
}

function bandIntroChunkStorageKey(targetLangId: string, practiceWordIds: string[]): string {
	const fp = [...practiceWordIds].sort().join(",")
	return `dismissedBandIntroChunk:${targetLangId}:${fp}`
}

function bandIntroBuildSessionStorageKey(targetLangId: string, sid: string): string {
	return `dismissedBandIntroBuildSession:${targetLangId}:${sid}`
}

/** Persist dismiss for this chunk and (when `sid` is set) suppress further band-intro dialogs this Build session. */
function persistBandIntroDismissal(
	targetLangId: string,
	practiceWordIds: string[],
	sid: string | null | undefined,
) {
	try {
		sessionStorage.setItem(bandIntroChunkStorageKey(targetLangId, practiceWordIds), "1")
		if (sid) sessionStorage.setItem(bandIntroBuildSessionStorageKey(targetLangId, sid), "1")
	} catch {
		/* ignore */
	}
}

/** Sentence-initial blank: no letters in the prompt before the cloze (allows quotes/space/punctuation). */
function isBlankAtSentenceStart(beforeBlank: string): boolean {
	return !/[\p{L}]/u.test(beforeBlank)
}

function capitalizeFirstGrapheme(s: string): string {
	const chars = [...s]
	if (chars.length === 0) return s
	const [head, ...rest] = chars
	return head.toLocaleUpperCase() + rest.join("")
}

function revealedLemmaDisplay(lemma: string, beforeBlank: string): string {
	if (!isBlankAtSentenceStart(beforeBlank)) return lemma
	return capitalizeFirstGrapheme(lemma)
}

function PracticePage() {
	const { vocabMode, sentenceId: forceSentenceId, wordId: forceWordId } = Route.useSearch()
	const navigate = useNavigate()
	/** `undefined` = loading; `null` = not signed in; object = signed-in profile */
	const [profile, setProfile] = useState<UserMe | null | undefined>(undefined)
	const [languageOptions, setLanguageOptions] = useState<LanguageOption[]>([])
	/** Practice pair (defaults from account when signed in; editable per session) */
	const [practiceNativeId, setPracticeNativeId] = useState<string>("")
	const [practiceTargetId, setPracticeTargetId] = useState<string>("")
	const [sessionId, setSessionId] = useState<string | null>(null)
	const [question, setQuestion] = useState<NextQuestion | null>(null)
	const [answer, setAnswer] = useState("")
	const [status, setStatus] = useState<"idle" | "loading" | "error">("idle")
	const [feedback, setFeedback] = useState<string | null>(null)
	const [assessmentDone, setAssessmentDone] = useState<{
		assumedRank?: number
		wordsTestedCount: number
		message: string
	} | null>(null)
	const [reportBusy, setReportBusy] = useState(false)
	const [reportMsg, setReportMsg] = useState<string | null>(null)
	/** Maps `wordId:targetSentenceId` → report id for this browser session (withdraw via Unreport). */
	const [reportIdByQuestionKey, setReportIdByQuestionKey] = useState<Record<string, string>>({})
	/** Build-mode vocab graph: pulse cell after each saved answer. */
	const [answerConfidenceFlash, setAnswerConfidenceFlash] = useState<{
		wordId: string
		confidence: number
		tick: number
		timesCorrect?: number
		timesTested?: number
	} | null>(null)
	const answerInputRef = useRef<HTMLInputElement>(null)
	const devMode = useDevStore((s) => s.devMode)
	const [devHighlightWordId, setDevHighlightWordId] = useState<string | null>(null)
	const [devUpcoming, setDevUpcoming] = useState<UpcomingData | null>(null)
	const [devUpcomingLoading, setDevUpcomingLoading] = useState(false)
	const [devTab, setDevTab] = useState<DevSelectionPanelTab>("band")
	const [devHoverWordId, setDevHoverWordId] = useState<string | null>(null)
	const [newWordsIntroPayload, setNewWordsIntroPayload] =
		useState<NewWordsColumnIntroPayload | null>(null)
	const [newWordsIntroBusy, setNewWordsIntroBusy] = useState(false)

	const onTerritoryColumnAdvanced = useCallback(
		(payload: TerritoryColumnAdvancedPayload) => {
			if (!sessionId || vocabMode !== "BUILD" || !practiceTargetId) return
			try {
				const k = `dismissedColumnBatch:${practiceTargetId}:${payload.columnIndex}`
				if (sessionStorage.getItem(k)) return
			} catch {
				/* sessionStorage unavailable */
			}
			setNewWordsIntroPayload({
				...payload,
				practiceWordIds: payload.practiceWordIds,
				introKind: "territory_column",
			})
			// #region agent log
			void fetch("http://127.0.0.1:7758/ingest/99baccff-1168-49a3-aecb-775311639d96", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "27db5e" },
				body: JSON.stringify({
					sessionId: "27db5e",
					location: "practice.tsx:onTerritoryColumnAdvanced",
					message: "territory column intro shown",
					data: {
						columnIndex: payload.columnIndex,
						lemmaCount: payload.practiceWordIds.length,
						hypothesisId: "H1",
					},
					timestamp: Date.now(),
					runId: "pre-fix",
				}),
			}).catch(() => {})
			// #endregion
		},
		[sessionId, vocabMode, practiceTargetId],
	)

	const fetchUpcoming = useCallback(async () => {
		if (!sessionId) return
		setDevUpcomingLoading(true)
		try {
			const params = new URLSearchParams()
			if (question?.wordId) params.set("peekWordId", question.wordId)
			const qs = params.toString()
			const res = await fetch(`/api/test/sessions/${sessionId}/upcoming${qs ? `?${qs}` : ""}`, {
				credentials: "include",
			})
			if (res.ok) setDevUpcoming(await res.json())
		} finally {
			setDevUpcomingLoading(false)
		}
	}, [sessionId, question?.wordId])

	// Refresh upcoming when session starts or after answering a question in dev mode
	useEffect(() => {
		if (devMode && sessionId && question) {
			void fetchUpcoming()
		}
	}, [devMode, sessionId, question, fetchUpcoming])

	useEffect(() => {
		if (!devMode) return
		const tab = question?.devSelection?.panelTab
		if (!tab) return
		if (tab === "band" || tab === "intros" || tab === "working") setDevTab(tab)
		else if (tab === "new") setDevTab("intros")
		else if (tab === "shaky") setDevTab("working")
		else setDevTab("band")
	}, [devMode, question?.devSelection?.panelTab])
	/** Deploy-controlled via `/api/settings` (`AppSettings.showHints`). */
	const [showInlineHints, setShowInlineHints] = useState(false)
	/** After a correct check, show the lemma in the sentence (still underlined). */
	const [clozeRevealed, setClozeRevealed] = useState(false)
	const [practiceWordPanel, setPracticeWordPanel] = useState<{
		word: WordPanelWord | null
		knowledge: WordPanelKnowledge | null
	}>({ word: null, knowledge: null })
	const [practiceWordSentences, setPracticeWordSentences] = useState<WordSentence[]>([])
	const [practiceWordPanelLoading, setPracticeWordPanelLoading] = useState(false)

	useEffect(() => {
		let cancelled = false
		void (async () => {
			const [meRes, langRes, settingsRes] = await Promise.all([
				fetch("/api/user/me", { credentials: "include" }),
				fetch("/api/languages?enabled=true"),
				fetch("/api/settings"),
			])
			if (!cancelled && langRes.ok) {
				const data = (await langRes.json()) as { languages: LanguageOption[] }
				setLanguageOptions(data.languages)
			}
			if (!cancelled && settingsRes.ok) {
				const s = (await settingsRes.json()) as { showHints?: boolean }
				setShowInlineHints(s.showHints === true)
			}
			if (!cancelled && meRes.ok) {
				const data = (await meRes.json()) as UserMe
				setProfile(data)
			} else if (!cancelled) {
				setProfile(null)
			}
		})()
		return () => {
			cancelled = true
		}
	}, [])

	useEffect(() => {
		if (profile?.nativeLanguage && profile?.targetLanguage) {
			setPracticeNativeId(profile.nativeLanguage.id)
			setPracticeTargetId(profile.targetLanguage.id)
		}
	}, [profile])

	const userMeLoaded = profile !== undefined
	const isGuest = profile === null
	const nativeLabel = languageOptions.find((l) => l.id === practiceNativeId)?.name
	const targetLabel = languageOptions.find((l) => l.id === practiceTargetId)?.name

	useEffect(() => {
		if (!userMeLoaded || !isGuest || vocabMode !== "BUILD") return
		void navigate({
			to: "/practice",
			search: (prev) => ({
				...prev,
				vocabMode: "ASSESSMENT",
			}),
			replace: true,
		})
	}, [userMeLoaded, isGuest, vocabMode, navigate])

	const maybeOfferWorkingSetThinIntro = useCallback(
		(
			nextData: { newWordsBandIntroOffer?: NewWordsBandIntroOffer | null },
			gateSessionId: string | null,
		) => {
			if (vocabMode !== "BUILD" || !practiceTargetId) return
			const offer = nextData.newWordsBandIntroOffer
			// #region agent log
			void fetch("http://127.0.0.1:7758/ingest/99baccff-1168-49a3-aecb-775311639d96", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "27db5e" },
				body: JSON.stringify({
					sessionId: "27db5e",
					location: "practice.tsx:maybeOfferWorkingSetThinIntro:entry",
					message: "band intro offer evaluation",
					data: {
						hasOffer: Boolean(offer),
						offerKind: offer?.kind,
						practiceN: offer?.practiceWordIds?.length,
						hypothesisId: "H1",
					},
					timestamp: Date.now(),
					runId: "pre-fix",
				}),
			}).catch(() => {})
			// #endregion
			if (
				!offer ||
				(offer.kind !== "working_set_thin" && offer.kind !== "intro_backlog") ||
				offer.practiceWordIds.length === 0
			)
				return
			if (gateSessionId) {
				try {
					if (
						sessionStorage.getItem(bandIntroBuildSessionStorageKey(practiceTargetId, gateSessionId))
					) {
						return
					}
				} catch {
					/* sessionStorage unavailable — continue */
				}
			}
			const fp = [...offer.practiceWordIds].sort().join(",")
			const dismissKey = bandIntroChunkStorageKey(practiceTargetId, offer.practiceWordIds)
			const legacyKey = `dismissedWorkingSetThinIntro:${practiceTargetId}:${fp}`
			let dismissed = false
			try {
				dismissed = !!(sessionStorage.getItem(dismissKey) || sessionStorage.getItem(legacyKey))
			} catch {
				/* sessionStorage unavailable — still offer dialog */
			}
			// #region agent log
			void fetch("http://127.0.0.1:7758/ingest/99baccff-1168-49a3-aecb-775311639d96", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "27db5e" },
				body: JSON.stringify({
					sessionId: "27db5e",
					location: "practice.tsx:maybeOfferWorkingSetThinIntro:dismiss",
					message: "band intro sessionStorage gate",
					data: { dismissed, fpLen: fp.length, dismissKey, hypothesisId: "H4" },
					timestamp: Date.now(),
					runId: "pre-fix",
				}),
			}).catch(() => {})
			// #endregion
			if (dismissed) return
			setNewWordsIntroPayload((prev) => {
				if (prev !== null) return prev
				// #region agent log
				void fetch("http://127.0.0.1:7758/ingest/99baccff-1168-49a3-aecb-775311639d96", {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "27db5e" },
					body: JSON.stringify({
						sessionId: "27db5e",
						location: "practice.tsx:maybeOfferWorkingSetThinIntro:setPayload",
						message: "showing band intro dialog",
						data: { introKind: offer.kind, hadPrev: prev !== null, hypothesisId: "H1" },
						timestamp: Date.now(),
						runId: "pre-fix",
					}),
				}).catch(() => {})
				// #endregion
				if (gateSessionId) {
					try {
						sessionStorage.setItem(
							bandIntroBuildSessionStorageKey(practiceTargetId, gateSessionId),
							"1",
						)
					} catch {
						/* ignore */
					}
				}
				return {
					introKind: offer.kind === "intro_backlog" ? "intro_backlog" : "working_set_thin",
					columnIndex: 0,
					wordIds: offer.wordIds,
					words: offer.words,
					practiceWordIds: offer.practiceWordIds,
					introBacklogCount: offer.introBacklogCount,
				}
			})
		},
		[vocabMode, practiceTargetId],
	)

	const loadNext = useCallback(
		async (sid: string): Promise<boolean> => {
			setStatus("loading")
			setFeedback(null)
			try {
				const nextRes = await fetch(`/api/test/sessions/${sid}/next`, { credentials: "include" })
				if (!nextRes.ok) {
					const errBody = await nextRes.json().catch(() => ({}))
					const msg =
						typeof errBody === "object" && errBody && "message" in errBody
							? String((errBody as { message?: string }).message)
							: await nextRes.text()
					throw new Error(msg || "No more questions")
				}
				const data = await nextRes.json()

				// Assessment mode: check if the binary search is done
				if (data.done) {
					setAssessmentDone({
						assumedRank: data.assumedRank,
						wordsTestedCount: data.wordsTestedCount,
						message: data.message,
					})
					setQuestion(null)
					setStatus("idle")
					// Auto-end the session to save the assumed rank
					await fetch(`/api/test/sessions/${sid}/end`, {
						method: "POST",
						credentials: "include",
					})
					return true
				}

				const q = data as NextQuestion
				// #region agent log
				void fetch("http://127.0.0.1:7758/ingest/99baccff-1168-49a3-aecb-775311639d96", {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "27db5e" },
					body: JSON.stringify({
						sessionId: "27db5e",
						location: "practice.tsx:loadNext",
						message: "next response before maybeOffer",
						data: {
							hasBandOffer: Boolean(q.newWordsBandIntroOffer),
							offerKind: q.newWordsBandIntroOffer?.kind,
							offerPracticeN: q.newWordsBandIntroOffer?.practiceWordIds?.length,
							devStrat: q.devSelection?.kind,
							hypothesisId: "H2",
						},
						timestamp: Date.now(),
						runId: "pre-fix",
					}),
				}).catch(() => {})
				// #endregion
				setQuestion(q)
				setAnswer("")
				setStatus("idle")
				maybeOfferWorkingSetThinIntro(q, sid)
				return true
			} catch (e) {
				setFeedback(e instanceof Error ? e.message : "Something went wrong")
				setStatus("error")
				return false
			}
		},
		[maybeOfferWorkingSetThinIntro],
	)

	const startBuildFallbackSession = useCallback(async (): Promise<boolean> => {
		setFeedback(null)
		setStatus("loading")
		try {
			const res = await fetch("/api/test/sessions", {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					mode: "TRANSLATION",
					vocabMode: "BUILD",
					nativeLanguageId: practiceNativeId,
					targetLanguageId: practiceTargetId,
				}),
			})
			if (!res.ok) {
				const t = await res.text()
				throw new Error(t || res.statusText)
			}
			const data = (await res.json()) as { sessionId: string }
			setSessionId(data.sessionId)
			navigate({
				to: "/practice",
				search: (prev) => ({ ...prev, vocabMode: "BUILD" }),
				replace: true,
			})
			return await loadNext(data.sessionId)
		} catch (e) {
			setSessionId(null)
			setQuestion(null)
			setFeedback(e instanceof Error ? e.message : "Could not start session")
			setStatus("error")
			return false
		}
	}, [practiceNativeId, practiceTargetId, navigate, loadNext])

	/** Attach heatmap column words to Build: server prioritizes them until each is tested once this session. */
	const beginColumnFocusBuildPractice = useCallback(
		async (
			columnFocusWordIds: string[],
			opts?: { existingSessionId?: string | null },
		): Promise<boolean> => {
			setFeedback(null)
			setStatus("loading")
			try {
				const existingId = opts?.existingSessionId ?? null
				if (existingId) {
					const patchRes = await fetch(`/api/test/sessions/${existingId}/column-focus`, {
						method: "PATCH",
						credentials: "include",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ wordIds: columnFocusWordIds }),
					})
					if (!patchRes.ok) {
						const t = await patchRes.text()
						throw new Error(t || patchRes.statusText)
					}
					let ok = false
					for (let attempt = 0; attempt < 6; attempt++) {
						ok = await loadNext(existingId)
						if (ok) break
					}
					if (!ok) {
						await fetch(`/api/test/sessions/${existingId}/column-focus`, {
							method: "PATCH",
							credentials: "include",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ clear: true }),
						})
						for (let attempt = 0; attempt < 4; attempt++) {
							ok = await loadNext(existingId)
							if (ok) break
						}
						if (!ok) {
							setFeedback("No cloze available for this column. Try again later.")
							setStatus("error")
							return false
						}
					}
					return true
				}

				const res = await fetch("/api/test/sessions", {
					method: "POST",
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mode: "TRANSLATION",
						vocabMode: "BUILD",
						nativeLanguageId: practiceNativeId,
						targetLanguageId: practiceTargetId,
						columnFocusWordIds,
					}),
				})
				if (!res.ok) {
					const t = await res.text()
					throw new Error(t || res.statusText)
				}
				const created = (await res.json()) as { sessionId: string }
				setSessionId(created.sessionId)
				navigate({
					to: "/practice",
					search: (prev) => ({ ...prev, vocabMode: "BUILD" }),
					replace: true,
				})
				let ok = false
				for (let attempt = 0; attempt < 6; attempt++) {
					ok = await loadNext(created.sessionId)
					if (ok) break
				}
				if (!ok) {
					await fetch(`/api/test/sessions/${created.sessionId}/end`, {
						method: "POST",
						credentials: "include",
					})
					return await startBuildFallbackSession()
				}
				return true
			} catch (e) {
				setSessionId(null)
				setQuestion(null)
				setFeedback(e instanceof Error ? e.message : "Could not start session")
				setStatus("error")
				return false
			}
		},
		[practiceNativeId, practiceTargetId, navigate, loadNext, startBuildFallbackSession],
	)

	const startSession = useCallback(async () => {
		setStatus("loading")
		setFeedback(null)
		try {
			if (!practiceNativeId || !practiceTargetId || practiceNativeId === practiceTargetId) {
				setFeedback("Choose two different languages (your language / language you're learning).")
				setStatus("error")
				return
			}

			if (vocabMode === "NEWWORDS") {
				setFeedback(
					"List-only New words sessions are started via the API with a word-id list. For heatmap columns, stay on Build vocabulary — column words are prioritized automatically until each is tested once.",
				)
				setStatus("error")
				return
			}

			if (vocabMode === "BUILD" && profile) {
				const heatmapRes = await fetch(
					`/api/progress/heatmap?from=1&to=10000&languageId=${encodeURIComponent(practiceTargetId)}`,
					{ credentials: "include" },
				)
				if (heatmapRes.ok) {
					const heatmap = (await heatmapRes.json()) as {
						assumedRank: number
						vocabSize: number
						cells: {
							wordId: string
							rank: number
							lemma: string
							confidence: number | null
							timesTested: number
							testSentenceCount: number
							curatedTestSentenceCount?: number
						}[]
					}
					const cellsForAnalysis = heatmap.cells.map((c) => ({
						wordId: c.wordId,
						rank: c.rank,
						lemma: c.lemma,
						confidence: c.confidence,
						timesTested: c.timesTested ?? 0,
					}))
					const analysis = analyzeBuildPracticeColumn(
						cellsForAnalysis,
						heatmap.assumedRank,
						heatmap.vocabSize,
					)
					if (analysis) {
						// Filter to words that actually have test sentences (cloze-resolvable).
						const testableSet = new Set(
							heatmap.cells.filter((c) => (c.testSentenceCount ?? 0) > 0).map((c) => c.wordId),
						)
						const testableWordIds = analysis.payload.wordIds.filter((id) => testableSet.has(id))
						if (testableWordIds.length > 0) {
							const introPayload: NewWordsColumnIntroPayload = {
								...analysis.payload,
								practiceWordIds: testableWordIds,
							}
							if (analysis.testedNotMasteredCount >= 1) {
								await beginColumnFocusBuildPractice(introPayload.wordIds)
								return
							}
							if (analysis.payload.wordIds.length >= MIN_TERRITORY_COLUMN_INTRO_LEMMAS) {
								setStatus("idle")
								setNewWordsIntroPayload(introPayload)
								return
							}
							await beginColumnFocusBuildPractice(introPayload.wordIds)
							return
						}
						// Frontier column has lemmas but none have joinable cloze — skip dead-end intro.
					}
				}
			}

			const body: Record<string, unknown> = {
				mode: "TRANSLATION",
				vocabMode,
				nativeLanguageId: practiceNativeId,
				targetLanguageId: practiceTargetId,
			}

			const res = await fetch("/api/test/sessions", {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			})
			if (!res.ok) {
				const t = await res.text()
				throw new Error(t || res.statusText)
			}
			const data = (await res.json()) as { sessionId: string }
			setSessionId(data.sessionId)
			const nextParams = new URLSearchParams()
			if (forceSentenceId) nextParams.set("sentenceId", forceSentenceId)
			if (forceWordId) nextParams.set("wordId", forceWordId)
			const nextQs = nextParams.toString()
			const nextUrl = `/api/test/sessions/${data.sessionId}/next${nextQs ? `?${nextQs}` : ""}`
			const nextRes = await fetch(nextUrl, {
				credentials: "include",
			})
			if (!nextRes.ok) {
				const errBody = await nextRes.json().catch(() => ({}))
				const msg =
					typeof errBody === "object" && errBody && "message" in errBody
						? String((errBody as { message?: string }).message)
						: await nextRes.text()
				throw new Error(msg || "No question available")
			}
			const nextData = await nextRes.json()

			// Assessment mode: check if done immediately
			if (nextData.done) {
				setAssessmentDone({
					assumedRank: nextData.assumedRank,
					wordsTestedCount: nextData.wordsTestedCount,
					message: nextData.message,
				})
				setStatus("idle")
				await fetch(`/api/test/sessions/${data.sessionId}/end`, {
					method: "POST",
					credentials: "include",
				})
				return
			}

			const q = nextData as NextQuestion
			setQuestion(q)
			setAnswer("")
			setStatus("idle")
			maybeOfferWorkingSetThinIntro(q, data.sessionId)
		} catch (e) {
			setSessionId(null)
			setQuestion(null)
			setFeedback(e instanceof Error ? e.message : "Something went wrong")
			setStatus("error")
		}
	}, [
		practiceNativeId,
		practiceTargetId,
		vocabMode,
		forceSentenceId,
		forceWordId,
		profile,
		beginColumnFocusBuildPractice,
		maybeOfferWorkingSetThinIntro,
	])

	// Auto-start when routed with a forced sentenceId (admin sentence testing)
	const autoStarted = useRef(false)
	useEffect(() => {
		if (
			forceSentenceId &&
			!autoStarted.current &&
			practiceNativeId &&
			practiceTargetId &&
			practiceNativeId !== practiceTargetId &&
			!sessionId
		) {
			autoStarted.current = true
			void startSession()
		}
	}, [forceSentenceId, practiceNativeId, practiceTargetId, sessionId, startSession])

	useEffect(() => {
		if (!question) return
		answerInputRef.current?.focus()
		setReportMsg(null)
	}, [question])

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when word/sentence identity changes
	useEffect(() => {
		setClozeRevealed(false)
		setPracticeWordPanel({ word: null, knowledge: null })
		setPracticeWordSentences([])
	}, [question?.wordId, question?.targetSentenceId])

	const openPracticeWordDetail = useCallback(async () => {
		if (!question) return
		setPracticeWordPanelLoading(true)
		try {
			const panel = await getWordPanelData({ data: { wordId: question.wordId } })
			if (!panel) return
			setPracticeWordPanel({ word: panel.word, knowledge: panel.knowledge })
			const nativeLanguageId = practiceNativeId || profile?.nativeLanguage?.id || null
			const res = await getWordSentences({
				data: { wordId: question.wordId, nativeLanguageId },
			})
			setPracticeWordSentences(res.sentences)
		} finally {
			setPracticeWordPanelLoading(false)
		}
	}, [question, practiceNativeId, profile?.nativeLanguage?.id])

	const submitAnswer = useCallback(async () => {
		if (!sessionId || !question) return
		const correct = normalizeAnswer(answer) === normalizeAnswer(question.lemma)
		if (correct) setClozeRevealed(true)
		setFeedback(correct ? "Correct." : "Not quite.")
		const res = await fetch(`/api/test/sessions/${sessionId}/answer`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				wordId: question.wordId,
				sentenceId: question.targetSentenceId,
				answerType: "TRANSLATION_TYPED",
				userAnswer: answer,
				correct,
				wasTypo: false,
			}),
		})
		if (!res.ok) {
			setFeedback("Could not record answer.")
			return
		}
		const data = (await res.json()) as {
			confidence?: number
			timesCorrect?: number
			timesTested?: number
			synonymFeedback?: { kind: "good" | "bad"; message: string }
			posMismatch?: { guessPos: string; targetPos: string; message: string }
		}

		if (!correct) {
			const expectedLine = `Not quite — expected “${question.lemma}”.`
			if (data.synonymFeedback?.kind === "good") {
				setClozeRevealed(true)
				setFeedback(data.synonymFeedback.message)
			} else if (data.synonymFeedback?.kind === "bad") {
				setFeedback(`${expectedLine} ${data.synonymFeedback.message}`)
			} else if (data.posMismatch) {
				setFeedback(`${expectedLine} ${data.posMismatch.message}`)
			} else {
				setFeedback(expectedLine)
			}
		}
		if (
			typeof data.confidence === "number" &&
			(vocabMode === "BUILD" || vocabMode === "NEWWORDS")
		) {
			setAnswerConfidenceFlash({
				wordId: question.wordId,
				confidence: data.confidence,
				tick: Date.now(),
				...(typeof data.timesTested === "number" && { timesTested: data.timesTested }),
				...(typeof data.timesCorrect === "number" && { timesCorrect: data.timesCorrect }),
			})
		}
	}, [sessionId, question, answer, vocabMode])

	const toggleClozeReport = useCallback(async () => {
		if (!question || !practiceNativeId || !practiceTargetId || reportBusy) return
		const qKey = clozeQuestionReportKey(question)
		const existingId = reportIdByQuestionKey[qKey]

		setReportBusy(true)
		setReportMsg(null)
		try {
			if (existingId) {
				const res = await fetch(`/api/test/cloze-reports/${existingId}`, {
					method: "DELETE",
					credentials: "include",
				})
				if (!res.ok) {
					const t = await res.text()
					throw new Error(t || res.statusText)
				}
				setReportIdByQuestionKey((prev) => {
					const next = { ...prev }
					delete next[qKey]
					return next
				})
				setReportMsg("Report withdrawn.")
				return
			}

			const res = await fetch("/api/test/cloze-reports", {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					nativeLanguageId: practiceNativeId,
					targetLanguageId: practiceTargetId,
					wordId: question.wordId,
					wordLemma: question.lemma,
					targetSentenceId: question.targetSentenceId,
					targetSentenceText: question.targetSentenceText,
					promptText: question.promptText,
					hintText: question.hintText,
					hintSentenceId: question.hintSentenceId,
					hintSource: question.hintSource,
					inlineHint: question.inlineHint,
					userGuess: answer.trim() || undefined,
				}),
			})
			if (!res.ok) {
				const t = await res.text()
				throw new Error(t || res.statusText)
			}
			const data = (await res.json()) as { id: string }
			setReportIdByQuestionKey((prev) => ({ ...prev, [qKey]: data.id }))
			setReportMsg("Report saved — thanks.")
		} catch (e) {
			setReportMsg(e instanceof Error ? e.message : "Could not update report")
		} finally {
			setReportBusy(false)
		}
	}, [question, practiceNativeId, practiceTargetId, reportBusy, reportIdByQuestionKey, answer])

	const practiceLanguagesInvalid =
		!practiceNativeId || !practiceTargetId || practiceNativeId === practiceTargetId
	const canStartPractice = userMeLoaded && !practiceLanguagesInvalid
	function resetPracticeUiAfterSignOut() {
		setProfile(null)
		setSessionId(null)
		setQuestion(null)
		setAnswer("")
		setFeedback(null)
		setPracticeNativeId("")
		setPracticeTargetId("")
		setStatus("idle")
		setReportIdByQuestionKey({})
		setAnswerConfidenceFlash(null)
		setClozeRevealed(false)
		setPracticeWordPanel({ word: null, knowledge: null })
		setPracticeWordSentences([])
	}

	const reportKeyForQuestion = question ? clozeQuestionReportKey(question) : ""
	const activeReportId = reportKeyForQuestion
		? reportIdByQuestionKey[reportKeyForQuestion]
		: undefined

	const hintLabel =
		question?.hintSource === "parallel"
			? `Hint (${nativeLabel ?? "your language"})`
			: "Hint (dictionary gloss)"

	if (!userMeLoaded) {
		return (
			<div className="flex-1 flex flex-col min-h-0">
				<PracticeHeader authState="loading" />
				<div className="max-w-xl mx-auto px-6 py-10 text-sm text-muted-foreground">Loading…</div>
			</div>
		)
	}

	const account = profile
	const header =
		account === null ? (
			<PracticeHeader authState="guest" />
		) : (
			<AuthedAppHeader
				pageTitle="Practice"
				user={{ id: account.id, name: account.name, email: account.email }}
				isAdmin={account.role === "ADMIN"}
				nativeLanguage={
					account.nativeLanguage
						? { id: account.nativeLanguage.id, code: account.nativeLanguage.code }
						: null
				}
				targetLanguage={
					account.targetLanguage
						? { id: account.targetLanguage.id, code: account.targetLanguage.code }
						: null
				}
				onNativeLanguageUpdated={(next) =>
					setProfile((p) => (p && p !== null ? { ...p, nativeLanguage: next } : p))
				}
				onAfterSignOut={resetPracticeUiAfterSignOut}
			/>
		)

	const showVocabGraph =
		(vocabMode === "BUILD" || vocabMode === "NEWWORDS") && !isGuest && !!practiceTargetId

	return (
		<div className="flex-1 flex flex-col min-h-0">
			{header}
			<NewWordsIntroDialog
				open={newWordsIntroPayload !== null}
				onOpenChange={(open) => {
					if (!open) {
						if (newWordsIntroPayload && practiceTargetId) {
							try {
								if (
									newWordsIntroPayload.introKind === "working_set_thin" ||
									newWordsIntroPayload.introKind === "intro_backlog"
								) {
									persistBandIntroDismissal(
										practiceTargetId,
										newWordsIntroPayload.practiceWordIds,
										sessionId,
									)
									// #region agent log
									void fetch("http://127.0.0.1:7758/ingest/99baccff-1168-49a3-aecb-775311639d96", {
										method: "POST",
										headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "27db5e" },
										body: JSON.stringify({
											sessionId: "27db5e",
											location: "practice.tsx:NewWordsIntroDialog.onOpenChange",
											message: "dismiss: band intro chunk",
											data: { introKind: newWordsIntroPayload.introKind, hypothesisId: "H3" },
											timestamp: Date.now(),
											runId: "pre-fix",
										}),
									}).catch(() => {})
									// #endregion
								} else {
									sessionStorage.setItem(
										`dismissedColumnBatch:${practiceTargetId}:${newWordsIntroPayload.columnIndex}`,
										"1",
									)
									// #region agent log
									void fetch("http://127.0.0.1:7758/ingest/99baccff-1168-49a3-aecb-775311639d96", {
										method: "POST",
										headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "27db5e" },
										body: JSON.stringify({
											sessionId: "27db5e",
											location: "practice.tsx:NewWordsIntroDialog.onOpenChange",
											message: "dismiss: column batch",
											data: {
												columnIndex: newWordsIntroPayload.columnIndex,
												introKind: newWordsIntroPayload.introKind,
												hypothesisId: "H3",
											},
											timestamp: Date.now(),
											runId: "pre-fix",
										}),
									}).catch(() => {})
									// #endregion
								}
							} catch {
								/* ignore */
							}
						}
						setNewWordsIntroPayload(null)
					}
				}}
				words={newWordsIntroPayload?.words ?? []}
				practiceLemmaCount={newWordsIntroPayload?.practiceWordIds.length ?? 0}
				introKind={
					newWordsIntroPayload?.introKind === "intro_backlog" ? "intro_backlog" : "territory_column"
				}
				introBacklogCount={newWordsIntroPayload?.introBacklogCount}
				columnIndex={newWordsIntroPayload?.columnIndex ?? 0}
				busy={newWordsIntroBusy}
				showCuratedUnlinkedCopy={newWordsIntroPayload?.showCuratedUnlinkedCopy ?? false}
				canBeginPractice={(newWordsIntroPayload?.practiceWordIds.length ?? 0) > 0}
				onBegin={async () => {
					if (!newWordsIntroPayload) return
					if (newWordsIntroPayload.practiceWordIds.length === 0) return
					setNewWordsIntroBusy(true)
					try {
						const ok = await beginColumnFocusBuildPractice(
							newWordsIntroPayload.wordIds,
							sessionId ? { existingSessionId: sessionId } : undefined,
						)
						// #region agent log
						if (ok) {
							if (
								newWordsIntroPayload.introKind === "working_set_thin" ||
								newWordsIntroPayload.introKind === "intro_backlog"
							) {
								persistBandIntroDismissal(
									practiceTargetId,
									newWordsIntroPayload.practiceWordIds,
									sessionId,
								)
							}
							void fetch("http://127.0.0.1:7758/ingest/99baccff-1168-49a3-aecb-775311639d96", {
								method: "POST",
								headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "27db5e" },
								body: JSON.stringify({
									sessionId: "27db5e",
									location: "practice.tsx:onBeginLetsPractice",
									message: "begin practice OK; payload cleared without onOpenChange path",
									data: {
										introKind: newWordsIntroPayload.introKind,
										wordCount: newWordsIntroPayload.wordIds.length,
										hypothesisId: "H3",
									},
									timestamp: Date.now(),
									runId: "pre-fix",
								}),
							}).catch(() => {})
						}
						// #endregion
						if (ok) setNewWordsIntroPayload(null)
					} finally {
						setNewWordsIntroBusy(false)
					}
				}}
			/>
			{showVocabGraph ? (
				<div className="w-full min-w-0 overflow-x-auto">
					<div className="mx-auto w-max max-w-none px-6 pt-8 pb-2">
						<VocabGraph
							languageId={practiceTargetId}
							activeWordId={
								devHoverWordId ??
								devHighlightWordId ??
								(sessionId && question ? question.wordId : null)
							}
							answerFlash={answerConfidenceFlash}
							showDevGrid={account?.role === "ADMIN" && devMode}
							onTerritoryColumnAdvanced={
								sessionId && vocabMode === "BUILD" ? onTerritoryColumnAdvanced : undefined
							}
						/>
					</div>
				</div>
			) : null}
			<div
				className={
					showVocabGraph
						? "w-full max-w-xl mx-auto px-6 pt-4 pb-8 space-y-6 flex-1 shrink-0"
						: "w-full max-w-xl mx-auto px-6 py-8 space-y-6 flex-1 shrink-0"
				}
			>
				{canStartPractice && (
					<Card>
						<CardHeader>
							<CardTitle className="text-base">{VOCAB_MODE_LABELS[vocabMode]}</CardTitle>
							<CardDescription>
								{vocabMode === "ASSESSMENT" ? (
									<>
										We&apos;ll find your vocabulary level via binary search. Correct = you know it,
										wrong = you don&apos;t.
									</>
								) : vocabMode === "FRUSTRATION" ? (
									<>Drill your stubbornest words. Short bursts, repeat throughout the day.</>
								) : vocabMode === "NEWWORDS" ? (
									<>
										Ordered word list only (API or legacy links). Heatmap columns from{" "}
										<Link to="/practice" search={{ vocabMode: "BUILD" }} className="underline">
											Build vocabulary
										</Link>{" "}
										stay in Build: each column word is asked first until you&apos;ve seen every one
										once, then normal Build picks resume.
									</>
								) : (
									<>
										Fill the blank in{" "}
										<span className="font-medium text-foreground">
											{targetLabel ?? "your target language"}
										</span>{" "}
										using the hint.
									</>
								)}
							</CardDescription>
						</CardHeader>

						<CardContent className="space-y-4">
							{assessmentDone ? (
								<div className="py-8 text-center space-y-4">
									<div className="text-4xl font-bold font-mono tracking-tight">
										{assessmentDone.assumedRank?.toLocaleString() ?? "—"}
									</div>
									<p className="text-sm text-muted-foreground">
										Estimated vocabulary rank — we assume you know the{" "}
										<span className="font-medium text-foreground">
											{assessmentDone.assumedRank?.toLocaleString() ?? "?"}
										</span>{" "}
										most common words.
									</p>
									<p className="text-xs text-muted-foreground">
										{assessmentDone.wordsTestedCount} questions answered
									</p>
									<div className="flex justify-center gap-3 pt-2">
										<Button asChild variant="outline" size="sm">
											<Link to="/dashboard">Back to dashboard</Link>
										</Button>
										<Button
											type="button"
											size="sm"
											onClick={() => {
												setAssessmentDone(null)
												setSessionId(null)
												setQuestion(null)
												setFeedback(null)
											}}
										>
											Retake assessment
										</Button>
									</div>
								</div>
							) : !sessionId || !question ? (
								<Button
									type="button"
									onClick={() => void startSession()}
									disabled={status === "loading" || practiceLanguagesInvalid}
								>
									{status === "loading" ? "Loading…" : "Start practice"}
								</Button>
							) : (
								<div className="w-full max-w-4xl mx-auto space-y-4">
									<div className="space-y-2">
										<div className="flex items-center gap-2">
											<Label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
												Sentence
											</Label>
											{question.rank > 0 && (
												<span className="text-[10px] font-mono text-muted-foreground/60 tabular-nums">
													#{question.rank.toLocaleString()}
												</span>
											)}
										</div>
										<p className="text-lg leading-relaxed font-medium text-pretty">
											<ClozePrompt
												promptText={question.promptText}
												inlineHint={showInlineHints ? question.inlineHint : null}
												revealedWord={clozeRevealed ? question.lemma : null}
												onRevealedWordTap={
													clozeRevealed ? () => void openPracticeWordDetail() : undefined
												}
											/>
										</p>
									</div>
									<div className="space-y-2 rounded-lg border border-border/80 bg-muted/30 p-4 min-h-22">
										<Label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
											{hintLabel}
										</Label>
										<p className="text-sm leading-relaxed text-muted-foreground text-pretty">
											{question.hintText}
										</p>
									</div>
									<div className="space-y-2">
										<Label
											htmlFor="cloze-answer"
											className="text-xs font-mono text-muted-foreground uppercase tracking-wider"
										>
											Your answer ({targetLabel})
										</Label>
										<Input
											ref={answerInputRef}
											id="cloze-answer"
											autoComplete="off"
											value={answer}
											onChange={(e) => setAnswer(e.target.value)}
											onKeyDown={(e) => {
												if (e.key !== "Enter") return
												e.preventDefault()
												if (feedback) {
													void loadNext(sessionId)
												} else {
													void submitAnswer()
												}
											}}
											placeholder="Lemma / word"
										/>
									</div>
									<div className="flex flex-wrap items-center gap-2 min-h-10">
										<Button type="button" onClick={() => void submitAnswer()}>
											Check{!isGuest ? " & save" : ""}
										</Button>
										<Button
											type="button"
											variant="outline"
											onClick={() => void loadNext(sessionId)}
										>
											Next
										</Button>
										<Button
											type="button"
											variant="outline"
											disabled={reportBusy}
											className={
												activeReportId ? "text-foreground ml-auto" : "text-muted-foreground ml-auto"
											}
											onClick={() => void toggleClozeReport()}
										>
											{reportBusy
												? activeReportId
													? "Removing…"
													: "Reporting…"
												: activeReportId
													? "Unreport"
													: "Report sentence"}
										</Button>
									</div>
									{reportMsg ? (
										<output className="text-xs text-muted-foreground block">{reportMsg}</output>
									) : null}
								</div>
							)}
							{feedback && (
								<p className="text-sm text-muted-foreground border-t border-border pt-4">
									{feedback}
								</p>
							)}
						</CardContent>
					</Card>
				)}
				{devMode && sessionId && question && (
					<DevUpcomingPanel
						data={devUpcoming}
						loading={devUpcomingLoading}
						activeTab={devTab}
						onTabChange={setDevTab}
						currentSelection={question.devSelection ?? null}
						highlightWordId={devHighlightWordId}
						onHighlightWord={setDevHighlightWordId}
						onHoverWord={setDevHoverWordId}
						onRefresh={fetchUpcoming}
					/>
				)}
			</div>
			<WordDetailDialog
				open={practiceWordPanel.word !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPracticeWordPanel({ word: null, knowledge: null })
						setPracticeWordSentences([])
					}
				}}
				variant="practice"
				word={practiceWordPanel.word}
				knowledge={practiceWordPanel.knowledge}
				sentences={practiceWordSentences}
				loadingSentences={practiceWordPanelLoading}
			/>
		</div>
	)
}

/** Renders the cloze sentence, replacing `____` with revealed lemma, inline hint, or a plain blank. */
function ClozePrompt({
	promptText,
	inlineHint,
	revealedWord,
	onRevealedWordTap,
}: {
	promptText: string
	inlineHint: string | null
	revealedWord: string | null
	/** When set with a revealed word, the lemma opens the shared word detail dialog. */
	onRevealedWordTap?: () => void
}) {
	const BLANK = "____"
	const idx = promptText.indexOf(BLANK)

	if (idx === -1) {
		return <>{promptText}</>
	}

	const before = promptText.slice(0, idx)
	const after = promptText.slice(idx + BLANK.length)

	const underlineClass = "underline underline-offset-4 decoration-brand/60 font-semibold"
	const showRevealed = revealedWord != null && revealedWord !== ""
	const revealedDisplay = showRevealed ? revealedLemmaDisplay(revealedWord, before) : ""
	const blank =
		showRevealed && onRevealedWordTap ? (
			<button
				type="button"
				className={`${underlineClass} text-foreground text-lg inline p-0 border-0 bg-transparent cursor-pointer font-inherit text-left hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm`}
				onClick={onRevealedWordTap}
			>
				{revealedDisplay}
			</button>
		) : showRevealed ? (
			<span className={`${underlineClass} text-foreground`}>{revealedDisplay}</span>
		) : inlineHint ? (
			<span className={`${underlineClass} text-brand`}>{inlineHint}</span>
		) : (
			BLANK
		)

	return (
		<>
			{before}
			{blank}
			{after}
		</>
	)
}

const DEV_TABS: DevSelectionPanelTab[] = ["band", "intros", "working"]

function DevUpcomingPanel({
	data,
	loading,
	activeTab,
	onTabChange,
	currentSelection,
	highlightWordId,
	onHighlightWord,
	onHoverWord,
	onRefresh,
}: {
	data: UpcomingData | null
	loading: boolean
	activeTab: DevSelectionPanelTab
	onTabChange: (tab: DevSelectionPanelTab) => void
	currentSelection: DevSelection | null
	highlightWordId: string | null
	onHighlightWord: (id: string | null) => void
	onHoverWord: (id: string | null) => void
	onRefresh: () => void
}) {
	const baseWords: UpcomingWord[] = !data
		? []
		: activeTab === "band"
			? data.activeBand
			: activeTab === "intros"
				? data.intros
				: data.workingSet
	// Surface the current card at the top of its own bucket even when the
	// filter queries don't include it — otherwise the user can't see where
	// the current pick sits in the list.
	const shouldInjectCurrent =
		data?.current != null &&
		currentSelection?.panelTab === activeTab &&
		!baseWords.some((w) => w.wordId === data.current?.wordId)
	const words: UpcomingWord[] =
		shouldInjectCurrent && data?.current ? [data.current, ...baseWords] : baseWords
	const refreshedAt = data?.generatedAt
		? new Date(data.generatedAt).toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			})
		: null

	return (
		<div className="border border-dashed border-brand/40 rounded-lg bg-brand/5 p-3 space-y-2">
			{currentSelection ? (
				<p className="text-[10px] font-mono text-brand/80 leading-snug border-b border-brand/15 pb-2">
					<span className="text-muted-foreground/80">This card: </span>
					<span className="text-foreground/90">{currentSelection.kind.replace(/_/g, " ")}</span>
					{" — "}
					{currentSelection.summary}
					{currentSelection.strategyOrder != null && currentSelection.strategyOrder.length > 0 ? (
						<>
							{" "}
							<span className="text-muted-foreground/70">
								(fallback order {currentSelection.strategyOrder.join(" → ")})
							</span>
						</>
					) : null}
					{currentSelection.primaryBucket != null && currentSelection.bucketOrder != null ? (
						<>
							{" "}
							<span className="text-muted-foreground/70">
								(rolled {currentSelection.primaryBucket}; order{" "}
								{currentSelection.bucketOrder.join(" → ")})
							</span>
						</>
					) : null}
				</p>
			) : null}
			{data?.devNextPickAfterSubmit ? (
				<div className="text-[10px] font-mono text-muted-foreground leading-snug border-b border-brand/15 pb-2 space-y-1">
					<p>
						<span className="text-brand/70">
							After submit (Q{data.devNextPickAfterSubmit.questionNumber}):
						</span>{" "}
						{data.devNextPickAfterSubmit.previewsDiffer ? (
							<>
								if correct →{" "}
								<span className="text-foreground/85">
									{data.devNextPickAfterSubmit.ifLastAnswerCorrect.kind.replace(/_/g, " ")}
								</span>
								{"; if wrong → "}
								<span className="text-foreground/85">
									{data.devNextPickAfterSubmit.ifLastAnswerWrong.kind.replace(/_/g, " ")}
								</span>
							</>
						) : (
							<span className="text-foreground/85">
								{data.devNextPickAfterSubmit.ifLastAnswerCorrect.kind.replace(/_/g, " ")}
							</span>
						)}
					</p>
					<p className="text-muted-foreground/80">
						{data.devNextPickAfterSubmit.previewsDiffer
							? `Correct: ${data.devNextPickAfterSubmit.ifLastAnswerCorrect.summary} — Wrong: ${data.devNextPickAfterSubmit.ifLastAnswerWrong.summary}`
							: data.devNextPickAfterSubmit.ifLastAnswerCorrect.summary}
					</p>
					<p className="text-muted-foreground/60 text-[9px]">
						Strategy display % (after thin boost if any): reinforce{" "}
						{data.devNextPickAfterSubmit.ifLastAnswerCorrect.strategyPercents.reinforce}, introduce{" "}
						{data.devNextPickAfterSubmit.ifLastAnswerCorrect.strategyPercents.introduce}, band{" "}
						{data.devNextPickAfterSubmit.ifLastAnswerCorrect.strategyPercents.bandWalk}
					</p>
				</div>
			) : data?.vocabMode && !["BUILD", "NEWWORDS"].includes(data.vocabMode) ? (
				<p className="text-[10px] font-mono text-muted-foreground border-b border-brand/15 pb-2">
					Next-pick preview applies to BUILD mode only (session: {data.vocabMode}).
				</p>
			) : null}
			<div className="flex items-center justify-between">
				<span className="text-[10px] font-mono uppercase tracking-wider text-brand/70">
					Dev: Upcoming words {data ? `(Q${data.questionNumber})` : ""}
					{data?.workingSetThin ? (
						<span className="normal-case text-muted-foreground font-mono">
							{" "}
							· working set thin ({data.workingSetCount} clozable in band)
						</span>
					) : null}
					{data?.introChunkGateActive ? (
						<span className="normal-case text-muted-foreground font-mono">
							{" "}
							· band chunk intro on next pick
						</span>
					) : null}
				</span>
				<div className="flex items-center gap-2">
					{refreshedAt ? (
						<span className="text-[9px] font-mono text-muted-foreground/60">{refreshedAt}</span>
					) : null}
					<button
						type="button"
						onClick={onRefresh}
						disabled={loading}
						className="text-[10px] font-mono text-brand/60 hover:text-brand transition-colors disabled:opacity-50"
					>
						{loading ? "..." : "Refresh"}
					</button>
				</div>
			</div>
			<div className="flex gap-1 flex-wrap">
				{DEV_TABS.map((tab) => {
					const n = !data
						? 0
						: tab === "band"
							? data.activeBand.length
							: tab === "intros"
								? data.intros.length
								: data.workingSet.length
					const label = tab === "band" ? "band" : tab === "intros" ? "intros" : "working"
					return (
						<button
							key={tab}
							type="button"
							onClick={() => onTabChange(tab)}
							className={`text-[10px] font-mono px-2 py-1 rounded transition-colors ${
								activeTab === tab
									? "bg-brand/20 text-brand"
									: "text-muted-foreground hover:text-foreground hover:bg-muted"
							}`}
						>
							{label} ({n})
						</button>
					)
				})}
			</div>
			{words.length === 0 ? (
				<p className="text-[10px] text-muted-foreground/60 font-mono py-2">
					{loading ? "Loading..." : "Empty"}
				</p>
			) : (
				<div className="space-y-0.5 max-h-48 overflow-auto">
					{words.map((w) => {
						const isHighlighted = highlightWordId === w.wordId
						const input = {
							confidence: w.confidence,
							timesTested: w.timesTested,
							lastTestedAt: w.lastTestedAt ? new Date(w.lastTestedAt) : null,
							streak: w.streak,
						}
						const afterCorrect = updateConfidence("BUILD", true, input).confidence
						const afterWrong = updateConfidence("BUILD", false, input).confidence
						const pct = (v: number) => `${(v * 100).toFixed(0)}%`
						return (
							<div
								key={w.wordId}
								className={`flex items-center gap-2 px-2 py-1 rounded text-[11px] font-mono transition-colors cursor-default ${
									isHighlighted ? "bg-brand/20 ring-1 ring-brand/40" : "hover:bg-muted/50"
								} ${w.testedInSession ? "opacity-50" : ""}`}
								onMouseEnter={() => onHoverWord(w.wordId)}
								onMouseLeave={() => onHoverWord(null)}
							>
								<span className="text-muted-foreground/60 tabular-nums w-12 shrink-0 text-right">
									#{w.rank}
								</span>
								<span className="flex-1 min-w-0 truncate">{w.lemma}</span>
								<span className="tabular-nums shrink-0 flex items-center gap-1">
									<span className="text-red-400">{pct(afterWrong)}</span>
									<span className="text-muted-foreground/40">&larr;</span>
									<span className="text-foreground font-medium">{pct(w.confidence)}</span>
									<span className="text-muted-foreground/40">&rarr;</span>
									<span className="text-green-400">{pct(afterCorrect)}</span>
								</span>
								{w.testedInSession && (
									<span className="text-[9px] text-muted-foreground/40">done</span>
								)}
								<button
									type="button"
									onClick={() => onHighlightWord(isHighlighted ? null : w.wordId)}
									className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded transition-colors ${
										isHighlighted
											? "bg-brand text-white"
											: "bg-muted text-muted-foreground hover:bg-brand/20 hover:text-brand"
									}`}
								>
									{isHighlighted ? "Hide" : "Show"}
								</button>
							</div>
						)
					})}
				</div>
			)}
		</div>
	)
}

function PracticeHeader({ authState }: { authState: "loading" | "guest" }) {
	return (
		<header className="shrink-0 border-b border-border/50 backdrop-blur-sm sticky top-0 z-10 bg-background/80">
			<div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3 sm:gap-4">
				<AppHeaderBrand compact />
				<h1 className="text-base sm:text-lg font-semibold tracking-tight min-w-0 truncate flex-1">
					Practice
				</h1>
				<div className="flex items-center gap-1 sm:gap-2 shrink-0">
					<ThemeToggleButton />
					{authState === "loading" ? null : (
						<Button type="button" variant="ghost" size="sm" asChild>
							<Link to="/auth/login">Sign in</Link>
						</Button>
					)}
				</div>
			</div>
		</header>
	)
}
