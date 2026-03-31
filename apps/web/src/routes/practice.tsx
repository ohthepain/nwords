import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { AppHeaderBrand } from "~/components/header"
import { authClient } from "~/lib/auth-client"
import { ThemeToggleButton } from "~/components/theme-toggle-button"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select"

type UserMe = {
	nativeLanguage: { id: string; name: string } | null
	targetLanguage: { id: string; name: string } | null
}

type LanguageOption = { id: string; name: string; code: string }

type NextQuestion = {
	wordId: string
	lemma: string
	targetSentenceId: string
	promptText: string
	targetSentenceText: string
	hintText: string
	hintSentenceId: string | null
	hintSource: "parallel" | "definition"
	answerType: "TRANSLATION_TYPED"
	sessionMode: string
}

export const Route = createFileRoute("/practice")({
	component: PracticePage,
	head: () => ({
		meta: [{ title: "Practice — nwords.live" }],
	}),
})

function normalizeAnswer(s: string): string {
	return s.trim().toLowerCase()
}

function PracticePage() {
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
				setProfile({ nativeLanguage: data.nativeLanguage, targetLanguage: data.targetLanguage })
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
	}, [profile?.nativeLanguage?.id, profile?.targetLanguage?.id])

	const userMeLoaded = profile !== undefined
	const isGuest = profile === null
	const hasAccountLanguages = !!(profile?.nativeLanguage && profile?.targetLanguage)

	function discardActiveRun() {
		setSessionId(null)
		setQuestion(null)
		setAnswer("")
		setFeedback(null)
		setStatus("idle")
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
			const q = (await nextRes.json()) as NextQuestion
			setQuestion(q)
			setAnswer("")
			setStatus("idle")
		} catch (e) {
			setSessionId(null)
			setQuestion(null)
			setFeedback(e instanceof Error ? e.message : "Something went wrong")
			setStatus("error")
		}
	}, [practiceNativeId, practiceTargetId])

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
			const q = (await nextRes.json()) as NextQuestion
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

	const practiceLanguagesInvalid =
		!practiceNativeId || !practiceTargetId || practiceNativeId === practiceTargetId
	const canStartPractice = userMeLoaded && !practiceLanguagesInvalid
	const practiceAuthState = !userMeLoaded ? "loading" : isGuest ? "guest" : "signedIn"

	async function handlePracticeSignOut() {
		await authClient.signOut()
		setProfile(null)
		setSessionId(null)
		setQuestion(null)
		setAnswer("")
		setFeedback(null)
		setPracticeNativeId("")
		setPracticeTargetId("")
		setStatus("idle")
		navigate({ to: "/practice", replace: true })
	}

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

	return (
		<div className="flex-1 flex flex-col min-h-0">
			<PracticeHeader authState={practiceAuthState} onSignOut={() => void handlePracticeSignOut()} />
			<div className="max-w-xl mx-auto px-6 py-8 space-y-6 flex-1">
				<Card>
					<CardHeader className="pb-4">
						<CardTitle className="text-base">Languages for this session</CardTitle>
						<CardDescription>
							{isGuest ? (
								<>
									You&apos;re not signed in. Pick your language and the one you&apos;re studying (they
									must differ).{" "}
									<Link to="/auth/register" className="text-foreground underline-offset-4 hover:underline">
										Sign up
									</Link>{" "}
									to save progress.
								</>
							) : hasAccountLanguages ? (
								<>
									Defaults match your account. Change below anytime for this run only —{" "}
									<Link to="/settings" className="text-foreground underline-offset-4 hover:underline">
										Settings
									</Link>{" "}
									updates what the dashboard uses.
								</>
							) : (
								<>
									Set default languages in{" "}
									<Link to="/settings" className="text-foreground underline-offset-4 hover:underline">
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
							<CardTitle className="text-base">Translation cloze</CardTitle>
							<CardDescription>
								Fill the blank in{" "}
								<span className="font-medium text-foreground">{targetLabel ?? "your target language"}</span>{" "}
								using the hint. Uses the pair you selected above.
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4">
							{!sessionId || !question ? (
								<Button
									type="button"
									onClick={() => void startSession()}
									disabled={status === "loading" || practiceLanguagesInvalid}
								>
									{status === "loading" ? "Loading…" : "Start practice"}
								</Button>
							) : (
								<>
									<div className="space-y-2">
										<Label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
											Sentence
										</Label>
										<p className="text-lg leading-relaxed font-medium">{question.promptText}</p>
									</div>
									<div className="space-y-2 rounded-lg border border-border/80 bg-muted/30 p-4">
										<Label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
											{hintLabel}
										</Label>
										<p className="text-sm leading-relaxed text-muted-foreground">{question.hintText}</p>
									</div>
									<div className="space-y-2">
										<Label
											htmlFor="cloze-answer"
											className="text-xs font-mono text-muted-foreground uppercase tracking-wider"
										>
											Your answer ({targetLabel})
										</Label>
										<Input
											id="cloze-answer"
											autoComplete="off"
											value={answer}
											onChange={(e) => setAnswer(e.target.value)}
											placeholder="Lemma / word"
										/>
									</div>
									<div className="flex flex-wrap gap-2">
										<Button type="button" onClick={() => void submitAnswer()}>
											Check{!isGuest ? " & save" : ""}
										</Button>
										<Button type="button" variant="outline" onClick={() => void loadNext(sessionId)}>
											Next
										</Button>
									</div>
								</>
							)}
							{feedback && (
								<p className="text-sm text-muted-foreground border-t border-border pt-4">{feedback}</p>
							)}
						</CardContent>
					</Card>
				)}
			</div>
		</div>
	)
}

function PracticeHeader({
	authState,
	onSignOut,
}: {
	authState: "loading" | "guest" | "signedIn"
	onSignOut?: () => void
}) {
	return (
		<header className="shrink-0 border-b border-border/50 backdrop-blur-sm sticky top-0 z-10 bg-background/80">
			<div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3 sm:gap-4">
				<AppHeaderBrand compact />
				<h1 className="text-base sm:text-lg font-semibold tracking-tight min-w-0 truncate flex-1">Practice</h1>
				<div className="flex items-center gap-1 sm:gap-2 shrink-0">
					<ThemeToggleButton />
					{authState === "loading" ? null : authState === "guest" ? (
						<Button type="button" variant="ghost" size="sm" asChild>
							<Link to="/auth/login">Sign in</Link>
						</Button>
					) : (
						<>
							<Button type="button" variant="ghost" size="sm" asChild>
								<Link to="/dashboard">Dashboard</Link>
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="text-muted-foreground"
								onClick={() => onSignOut?.()}
							>
								Sign out
							</Button>
						</>
					)}
				</div>
			</div>
		</header>
	)
}
