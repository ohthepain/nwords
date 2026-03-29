import { app } from "@nwords/api"
import { prisma } from "@nwords/db"
import { Link, createFileRoute, useRouter } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { useState } from "react"
import { Button } from "~/components/ui/button"
import { forwardedAdminApiHeaders } from "~/lib/server-admin-api"

const getLanguages = createServerFn({ method: "GET" }).handler(async () => {
	const languages = await prisma.language.findMany({
		orderBy: { name: "asc" },
		include: {
			_count: { select: { words: true, sentences: true } },
		},
	})
	return languages.map((l) => ({
		id: l.id,
		code: l.code,
		name: l.name,
		enabled: l.enabled,
		wordCount: l._count.words,
		sentenceCount: l._count.sentences,
	}))
})

const toggleLanguage = createServerFn({ method: "POST" })
	.inputValidator((data: { id: string; enabled: boolean }) => data)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) {
			throw new Error("Missing request context")
		}
		const origin = new URL(request.url).origin
		const json = JSON.stringify({ enabled: data.enabled })
		const res = await app.fetch(
			new Request(`${origin}/api/admin/languages/${data.id}/toggle`, {
				method: "PATCH",
				headers: forwardedAdminApiHeaders(request, { jsonBody: json }),
				body: json,
			}),
		)
		const body = (await res.json().catch(() => ({}))) as {
			error?: string
			pipelineJobId?: string | null
		}
		if (!res.ok) {
			throw new Error(body.error ?? `Toggle failed (${res.status})`)
		}
		return { success: true, pipelineJobId: body.pipelineJobId ?? null }
	})

const runLanguagePipeline = createServerFn({ method: "POST" })
	.inputValidator((data: { id: string }) => data)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) {
			throw new Error("Missing request context")
		}
		const origin = new URL(request.url).origin
		const res = await app.fetch(
			new Request(`${origin}/api/admin/languages/${data.id}/run-pipeline`, {
				method: "POST",
				headers: forwardedAdminApiHeaders(request),
			}),
		)
		const body = (await res.json().catch(() => ({}))) as {
			error?: string
			pipelineJobId?: string
		}
		if (!res.ok) {
			throw new Error(body.error ?? `Pipeline failed (${res.status})`)
		}
		return { success: true, pipelineJobId: body.pipelineJobId }
	})

export const Route = createFileRoute("/_authed/_admin/admin/languages")({
	loader: () => getLanguages(),
	component: AdminLanguagesPage,
})

function AdminLanguagesPage() {
	const router = useRouter()
	const languages = Route.useLoaderData()
	const [toggling, setToggling] = useState<string | null>(null)
	const [runningPipeline, setRunningPipeline] = useState<string | null>(null)
	const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

	const enabledCount = languages.filter((l) => l.enabled).length
	const withWords = languages.filter((l) => l.wordCount > 0).length

	async function handleToggle(id: string, currentlyEnabled: boolean) {
		setNotice(null)
		setToggling(id)
		try {
			const out = await toggleLanguage({ data: { id, enabled: !currentlyEnabled } })
			if (out.pipelineJobId) {
				setNotice({
					kind: "ok",
					text: `Ingestion started — job ${out.pipelineJobId.slice(0, 8)}… Open Jobs to track.`,
				})
			}
		} catch (e) {
			setNotice({ kind: "err", text: e instanceof Error ? e.message : "Toggle failed" })
		} finally {
			setToggling(null)
		}
		await router.invalidate()
	}

	async function handleRunPipeline(id: string) {
		setNotice(null)
		setRunningPipeline(id)
		try {
			const out = await runLanguagePipeline({ data: { id } })
			setNotice({
				kind: "ok",
				text: `Pipeline queued — job ${out.pipelineJobId.slice(0, 8)}… Open Jobs for progress.`,
			})
		} catch (e) {
			setNotice({ kind: "err", text: e instanceof Error ? e.message : "Pipeline failed" })
		} finally {
			setRunningPipeline(null)
		}
		await router.invalidate()
	}

	return (
		<div className="p-6 space-y-6">
			<div className="text-sm text-muted-foreground space-y-1">
				<p>Manage which languages are available to users.</p>
				<p className="text-xs">
					Turning a language <strong className="text-foreground font-medium">on</strong> (from off)
					with no words yet starts the pipeline automatically. Use{" "}
					<strong className="text-foreground font-medium">Re-import</strong> to run it again any
					time (updates existing lemmas). Track progress under Jobs.
				</p>
				<p className="text-xs">
					Pipeline: Kaikki.org (four{" "}
					<a
						href="https://kaikki.org/dictionary/Italian/pos-noun/index.html"
						target="_blank"
						rel="noreferrer"
						className="underline underline-offset-2 hover:text-foreground"
					>
						pos-noun
					</a>
					-style JSONL streams when available, else one full dump) →{" "}
					<a
						href="https://github.com/bnpd/freqListsLemmatized"
						target="_blank"
						rel="noreferrer"
						className="underline underline-offset-2 hover:text-foreground"
					>
						bnpd/freqListsLemmatized
					</a>{" "}
					ranks → Tatoeba sentences (ISO 639-3 required).
				</p>
			</div>

			{notice ? (
				<output
					className={`text-sm rounded-md border px-3 py-2 block ${
						notice.kind === "ok"
							? "border-known/50 bg-known/10 text-foreground"
							: "border-destructive/50 bg-destructive/10 text-destructive"
					}`}
				>
					{notice.text}
				</output>
			) : null}

			{/* Summary stats */}
			<div className="flex items-center gap-6 text-sm">
				<div className="flex items-center gap-2">
					<span className="size-2 rounded-full bg-muted-foreground" />
					<span className="text-muted-foreground">
						<span className="font-mono font-medium text-foreground">{languages.length}</span> total
					</span>
				</div>
				<div className="flex items-center gap-2">
					<span className="size-2 rounded-full bg-known" />
					<span className="text-muted-foreground">
						<span className="font-mono font-medium text-foreground">{enabledCount}</span> enabled
					</span>
				</div>
				<div className="flex items-center gap-2">
					<span className="size-2 rounded-full bg-brand" />
					<span className="text-muted-foreground">
						<span className="font-mono font-medium text-foreground">{withWords}</span> with words
					</span>
				</div>
			</div>

			{/* Table */}
			<div className="border border-border rounded-lg overflow-hidden">
				<div className="grid grid-cols-[1fr_90px_90px_100px_108px] gap-4 text-[10px] font-mono text-muted-foreground uppercase tracking-[0.15em] px-4 py-2.5 bg-muted/50 border-b border-border">
					<span>Language</span>
					<span className="text-right">Words</span>
					<span className="text-right">Sentences</span>
					<span className="text-right">On</span>
					<span className="text-right">Import</span>
				</div>
				<div className="divide-y divide-border">
					{languages.map((lang) => (
						<div
							key={lang.id}
							className="grid grid-cols-[1fr_90px_90px_100px_108px] gap-4 items-center px-4 py-2.5 hover:bg-muted/30 transition-colors"
						>
							<div className="flex flex-col gap-1 min-w-0">
								<div className="flex items-center gap-3 min-w-0">
									<span className="text-sm font-medium truncate">{lang.name}</span>
									<span className="text-xs font-mono text-muted-foreground bg-muted rounded px-1.5 py-0.5 shrink-0">
										{lang.code}
									</span>
								</div>
								<div className="flex items-center gap-2 text-[11px]">
									<Link
										to="/admin/words"
										search={{ languageId: lang.id }}
										className="text-muted-foreground hover:text-foreground underline underline-offset-2"
									>
										Words
									</Link>
									<span className="text-border select-none">·</span>
									<Link
										to="/admin/sentences"
										search={{ languageId: lang.id }}
										className="text-muted-foreground hover:text-foreground underline underline-offset-2"
									>
										Sentences
									</Link>
								</div>
							</div>
							<span className="text-sm font-mono text-right tabular-nums">
								{lang.wordCount > 0 ? (
									lang.wordCount.toLocaleString()
								) : (
									<span className="text-muted-foreground">—</span>
								)}
							</span>
							<span className="text-sm font-mono text-right tabular-nums">
								{lang.sentenceCount > 0 ? (
									lang.sentenceCount.toLocaleString()
								) : (
									<span className="text-muted-foreground">—</span>
								)}
							</span>
							<div className="flex justify-end">
								<Button
									variant={lang.enabled ? "default" : "outline"}
									size="sm"
									className="h-7 text-xs w-20 font-mono"
									disabled={toggling === lang.id || runningPipeline === lang.id}
									onClick={() => handleToggle(lang.id, lang.enabled)}
								>
									{lang.enabled ? "On" : "Off"}
								</Button>
							</div>
							<div className="flex justify-end">
								<Button
									variant="secondary"
									size="sm"
									className="h-7 text-xs px-2 font-mono"
									disabled={runningPipeline === lang.id || toggling === lang.id}
									onClick={() => handleRunPipeline(lang.id)}
								>
									{runningPipeline === lang.id ? "…" : "Re-import"}
								</Button>
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	)
}
