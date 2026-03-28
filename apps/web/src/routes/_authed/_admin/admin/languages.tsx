import { prisma } from "@nwords/db"
import { createFileRoute } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { useState } from "react"
import { Button } from "~/components/ui/button"

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
		await prisma.language.update({
			where: { id: data.id },
			data: { enabled: data.enabled },
		})
		return { success: true }
	})

export const Route = createFileRoute("/_authed/_admin/admin/languages")({
	loader: () => getLanguages(),
	component: AdminLanguagesPage,
})

function AdminLanguagesPage() {
	const languages = Route.useLoaderData()
	const [toggling, setToggling] = useState<string | null>(null)

	const enabledCount = languages.filter((l) => l.enabled).length
	const withWords = languages.filter((l) => l.wordCount > 0).length

	async function handleToggle(id: string, currentlyEnabled: boolean) {
		setToggling(id)
		await toggleLanguage({ data: { id, enabled: !currentlyEnabled } })
		setToggling(null)
		window.location.reload()
	}

	return (
		<div className="p-6 space-y-6">
			{/* Header */}
			<div>
				<h1 className="text-xl font-bold">Languages</h1>
				<p className="text-sm text-muted-foreground mt-1">
					Manage which languages are available to users
				</p>
			</div>

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
				<div className="grid grid-cols-[1fr_90px_90px_100px] gap-4 text-[10px] font-mono text-muted-foreground uppercase tracking-[0.15em] px-4 py-2.5 bg-muted/50 border-b border-border">
					<span>Language</span>
					<span className="text-right">Words</span>
					<span className="text-right">Sentences</span>
					<span className="text-right">Status</span>
				</div>
				<div className="divide-y divide-border">
					{languages.map((lang) => (
						<div
							key={lang.id}
							className="grid grid-cols-[1fr_90px_90px_100px] gap-4 items-center px-4 py-2.5 hover:bg-muted/30 transition-colors"
						>
							<div className="flex items-center gap-3">
								<span className="text-sm font-medium">{lang.name}</span>
								<span className="text-xs font-mono text-muted-foreground bg-muted rounded px-1.5 py-0.5">
									{lang.code}
								</span>
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
									disabled={toggling === lang.id}
									onClick={() => handleToggle(lang.id, lang.enabled)}
								>
									{lang.enabled ? "On" : "Off"}
								</Button>
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	)
}
