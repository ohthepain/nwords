import { Link, createFileRoute } from "@tanstack/react-router"
import { useCallback, useEffect, useRef, useState } from "react"
import { AuthedAppHeader } from "~/components/authed-app-header"
import { AppHeaderBrand } from "~/components/header"
import { ThemeToggleButton } from "~/components/theme-toggle-button"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select"
type UserMe = {
	id: string
	name: string
	email: string | null
	role: string
	nativeLanguage: { id: string; name: string } | null
	targetLanguage: { id: string; name: string } | null
}

type LanguageOption = { id: string; name: string; code: string }

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
}

type VocabMode = "ASSESSMENT" | "BUILD" | "FRUSTRATION"

const VOCAB_MODE_LABELS: Record<VocabMode, string> = {
	ASSESSMENT: "Assessment",
	BUILD: "Build vocabulary",
	FRUSTRATION: "Frustration words",
}

export const Route = createFileRoute("/practice")({
	component: PracticePage,
	validateSearch: (search: Record<string, unknown>) => ({
		vocabMode: (["ASSESSMENT", "BUILD", "FRUSTRATION"].includes(search.vocabMode as string)
			? search.vocabMode
			: "BUILD") as VocabMode,
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

function PracticePage() {
	const { vocabMode } = Route.useSearch()
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
	const answerInputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		let cancelled = false
		void (async () => {
			const [meRes, langRes] = await Promise.all([
				fetch("/api/user/me", { credentials: "include" }),
				fetch("/api/languages?enabled=true"),
			])
			if (!cancelled && langRes.ok) {
				const data = (await langRes.json()) as { languages: LanguageOption[] }
				setLanguageOptions(data.languages)
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
	const hasAccountLanguages = !!(profile?.nativeLanguage && profile?.targetLanguage)

	function discardActiveRun() {
		setSessionId(null)
		setQuestion(null)
		setAnswer("")
		setFeedback(null)
		setAssessmentDone(null)
		setStatus("idle")
		setReportIdByQuestionKey({})
	}

	const nativeLabel = languageOptions.find((l) => l.id === practiceNativeId)?.name
	const targetLabel = languageOptions.find((l) => l.id === practiceTargetId)?.name

	const startSession = useCallback(async () => {
		setStatus("loading")
		setFeedback(null)
		try {
			if (!practiceNativeId || !practiceTargetId || practiceNativeId === practiceTargetId) {
				setFeedback("Choose two different languages (your language / language you're learning).")
				setStatus("error")
				return
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
			const nextRes = await fetch(`/api/test/sessions/${data.sessionId}/next`, {
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
		} catch (e) {
			setSessionId(null)
			setQuestion(null)
			setFeedback(e instanceof Error ? e.message : "Something went wrong")
			setStatus("error")
		}
	}, [practiceNativeId, practiceTargetId, vocabMode])

	useEffect(() => {
		if (!question) return
		answerInputRef.current?.focus()
		setReportMsg(null)
	}, [question])

	const loadNext = useCallback(async (sid: string) => {
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
				return
			}

			const q = data as NextQuestion
			setQuestion(q)
			setAnswer("")
			setStatus("idle")
		} catch (e) {
			setFeedback(e instanceof Error ? e.message : "Something went wrong")
			setStatus("error")
		}
	}, [])

	const submitAnswer = useCallback(async () => {
		if (!sessionId || !question) return
		const correct = normalizeAnswer(answer) === normalizeAnswer(question.lemma)
		setFeedback(correct ? "Correct." : `Not quite — expected “${question.lemma}”.`)
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
	}, [sessionId, question, answer])

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
	}, [question, practiceNativeId, practiceTargetId, reportBusy, reportIdByQuestionKey])

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
				signOutNavigateTo="/practice"
				onAfterSignOut={resetPracticeUiAfterSignOut}
			/>
		)

	return (
		<div className="flex-1 flex flex-col min-h-0">
			{header}
			<div className="w-full max-w-xl mx-auto px-6 py-8 space-y-6 flex-1 shrink-0">
				<Card>
					<CardHeader className="pb-4">
						<CardTitle className="text-base">Languages for this session</CardTitle>
						<CardDescription>
							{isGuest ? (
								<>
									You&apos;re not signed in. Pick your language and the one you&apos;re studying
									(they must differ).{" "}
									<Link
										to="/auth/register"
										className="text-foreground underline-offset-4 hover:underline"
									>
										Sign up
									</Link>{" "}
									to save progress.
								</>
							) : hasAccountLanguages ? (
								<>
									Defaults match your account. Change below anytime for this run only —{" "}
									<Link
										to="/settings"
										className="text-foreground underline-offset-4 hover:underline"
									>
										Settings
									</Link>{" "}
									updates what the dashboard uses.
								</>
							) : (
								<>
									Set default languages in{" "}
									<Link
										to="/settings"
										className="text-foreground underline-offset-4 hover:underline"
									>
										Settings
									</Link>{" "}
									for your dashboard; you can still choose a pair here to practice now.
								</>
							)}
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-2">
								<Label htmlFor="practice-native">Your language</Label>
								<Select
									value={practiceNativeId}
									onValueChange={(v) => {
										setPracticeNativeId(v)
										if (sessionId) discardActiveRun()
									}}
								>
									<SelectTrigger id="practice-native" className="w-full min-w-0">
										<SelectValue placeholder="Language you know" />
									</SelectTrigger>
									<SelectContent>
										{languageOptions.map((l) => (
											<SelectItem key={l.id} value={l.id}>
												{l.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-2">
								<Label htmlFor="practice-target">Language you&apos;re learning</Label>
								<Select
									value={practiceTargetId}
									onValueChange={(v) => {
										setPracticeTargetId(v)
										if (sessionId) discardActiveRun()
									}}
								>
									<SelectTrigger id="practice-target" className="w-full min-w-0">
										<SelectValue placeholder="Target language" />
									</SelectTrigger>
									<SelectContent>
										{languageOptions.map((l) => (
											<SelectItem key={l.id} value={l.id}>
												{l.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
						{practiceLanguagesInvalid && (
							<p className="text-sm text-muted-foreground">
								Choose two different languages above to start.
							</p>
						)}
					</CardContent>
				</Card>

				{canStartPractice && (
					<Card>
						<CardHeader>
							<CardTitle className="text-base">
								{VOCAB_MODE_LABELS[vocabMode]}
							</CardTitle>
							<CardDescription>
								{vocabMode === "ASSESSMENT" ? (
									<>
										We&apos;ll find your vocabulary level via binary search.
										Correct = you know it, wrong = you don&apos;t.
									</>
								) : vocabMode === "FRUSTRATION" ? (
									<>
										Drill your stubbornest words. Short bursts, repeat throughout the day.
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
								<div className="w-full max-w-xl mx-auto space-y-4">
									<div className="space-y-2 min-h-[7rem]">
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
												inlineHint={question.inlineHint}
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
			</div>
		</div>
	)
}

/** Renders the cloze sentence, replacing `____` with the native-language inline hint (underlined) or a plain blank. */
function ClozePrompt({
	promptText,
	inlineHint,
}: { promptText: string; inlineHint: string | null }) {
	const BLANK = "____"
	const idx = promptText.indexOf(BLANK)

	if (idx === -1 || !inlineHint) {
		return <>{promptText}</>
	}

	const before = promptText.slice(0, idx)
	const after = promptText.slice(idx + BLANK.length)

	return (
		<>
			{before}
			<span className="underline underline-offset-4 decoration-brand/60 text-brand font-semibold">
				{inlineHint}
			</span>
			{after}
		</>
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
