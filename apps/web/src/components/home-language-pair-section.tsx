"use client"

import { useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { LanguagePairSelectRow } from "~/components/language-pair-select-row"
import {
	clearStoredPracticeLanguagePair,
	readStoredPracticeLanguagePair,
	writeStoredPracticeLanguagePair,
} from "~/lib/practice-language-pair-storage"

type LanguageOption = { id: string; name: string; code: string }

export type HomeLanguagePairSectionProps = {
	/** When set, language changes are saved to the account before starting practice. */
	account?: { user: { id: string } } | null
	languageProfiles?: { languageId: string; assumedRank: number }[]
	/** Logged-in user's saved pair from the server (shown first when both are set). */
	accountNativeLanguageId?: string
	accountTargetLanguageId?: string
}

function assumedRankForTarget(
	profiles: { languageId: string; assumedRank: number }[],
	targetId: string,
): number | null {
	if (!targetId) return null
	const r = profiles.find((p) => p.languageId === targetId)?.assumedRank ?? 0
	return r > 0 ? r : null
}

export function HomeLanguagePairSection({
	account = null,
	languageProfiles = [],
	accountNativeLanguageId,
	accountTargetLanguageId,
}: HomeLanguagePairSectionProps) {
	const navigate = useNavigate()
	const [allLanguageOptions, setAllLanguageOptions] = useState<LanguageOption[]>([])
	const [languageOptions, setLanguageOptions] = useState<LanguageOption[]>([])
	const [nativeId, setNativeId] = useState("")
	const [targetId, setTargetId] = useState("")
	const [startBusy, setStartBusy] = useState(false)
	const [startError, setStartError] = useState<string | null>(null)

	useEffect(() => {
		let cancelled = false
		void (async () => {
			const [langAllRes, langRes] = await Promise.all([
				fetch("/api/languages"),
				fetch("/api/languages?enabled=true"),
			])
			let allLangs: LanguageOption[] = []
			let enabledLangs: LanguageOption[] = []
			if (langAllRes.ok) {
				const data = (await langAllRes.json()) as { languages: LanguageOption[] }
				allLangs = data.languages
				if (!cancelled) setAllLanguageOptions(data.languages)
			}
			if (langRes.ok) {
				const data = (await langRes.json()) as { languages: LanguageOption[] }
				enabledLangs = data.languages
				if (!cancelled) setLanguageOptions(data.languages)
			}
			if (cancelled) return

			const nativeOpts = allLangs.length > 0 ? allLangs : enabledLangs

			function pairExistsInLists(native: string, target: string): boolean {
				if (!native || !target || native === target) return false
				const nativeOk = nativeOpts.some((l) => l.id === native)
				const targetOk = enabledLangs.some((l) => l.id === target)
				return nativeOk && targetOk
			}

			const fromAccount =
				accountNativeLanguageId &&
				accountTargetLanguageId &&
				accountNativeLanguageId !== accountTargetLanguageId &&
				pairExistsInLists(accountNativeLanguageId, accountTargetLanguageId)
					? {
							nativeLanguageId: accountNativeLanguageId,
							targetLanguageId: accountTargetLanguageId,
						}
					: null

			const stored = readStoredPracticeLanguagePair()
			const fromStored =
				stored &&
				pairExistsInLists(stored.nativeLanguageId, stored.targetLanguageId)
					? stored
					: null

			const initial = fromAccount ?? fromStored
			if (initial) {
				setNativeId(initial.nativeLanguageId)
				setTargetId(initial.targetLanguageId)
			}
		})()
		return () => {
			cancelled = true
		}
	}, [accountNativeLanguageId, accountTargetLanguageId])

	const nativeLanguageOptions = allLanguageOptions.length > 0 ? allLanguageOptions : languageOptions

	function persistPair(nextNative: string, nextTarget: string) {
		setNativeId(nextNative)
		setTargetId(nextTarget)
		if (nextNative && nextTarget && nextNative !== nextTarget) {
			writeStoredPracticeLanguagePair({
				nativeLanguageId: nextNative,
				targetLanguageId: nextTarget,
			})
		} else {
			clearStoredPracticeLanguagePair()
		}
	}

	return (
		<div className="w-full max-w-xl mx-auto mb-8 text-left space-y-3">
			<LanguagePairSelectRow
				nativeLabel="I speak"
				targetLabel="I study"
				nativeLanguages={nativeLanguageOptions}
				targetLanguages={languageOptions}
				nativeValue={nativeId}
				targetValue={targetId}
				onNativeChange={(id) => persistPair(id, targetId)}
				onTargetChange={(id) => persistPair(nativeId, id)}
				nativeSelectId="home-native-lang"
				targetSelectId="home-target-lang"
				measureBuild={{
					assumedRankForSelectedTarget: assumedRankForTarget(languageProfiles, targetId),
					knownCountForSelectedTarget: null,
					actionBusy: startBusy,
					actionBusyLabel: "Saving…",
					onMeasureOrBuildClick: async () => {
						if (!nativeId || !targetId || nativeId === targetId) return
						setStartError(null)
						const rank = assumedRankForTarget(languageProfiles, targetId)
						const nextMode = rank != null && rank > 0 ? ("BUILD" as const) : ("ASSESSMENT" as const)
						if (account) {
							setStartBusy(true)
							try {
								const res = await fetch("/api/user/me/languages", {
									method: "PATCH",
									credentials: "include",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({
										nativeLanguageId: nativeId,
										targetLanguageId: targetId,
									}),
								})
								const body = (await res.json().catch(() => ({}))) as { error?: string }
								if (!res.ok) {
									setStartError(body.error ?? "Could not save your languages.")
									return
								}
							} finally {
								setStartBusy(false)
							}
						} else {
							writeStoredPracticeLanguagePair({
								nativeLanguageId: nativeId,
								targetLanguageId: targetId,
							})
						}
						void navigate({ to: "/practice", search: { vocabMode: nextMode } })
					},
				}}
			/>
			{startError ? (
				<p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
					{startError}
				</p>
			) : null}
		</div>
	)
}
