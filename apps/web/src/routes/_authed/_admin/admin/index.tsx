import { Link, createFileRoute } from "@tanstack/react-router"
import {
	BookOpen,
	Flag,
	Languages,
	ListTodo,
	MessageSquareText,
	SlidersHorizontal,
} from "lucide-react"
import { Button } from "~/components/ui/button"

export const Route = createFileRoute("/_authed/_admin/admin/")({
	component: AdminHomePage,
})

function AdminHomePage() {
	return (
		<div className="p-6 max-w-lg mx-auto space-y-6">
			<p className="text-sm text-muted-foreground">Choose an admin area</p>
			<div className="grid gap-3">
				<Button variant="outline" className="h-auto py-5 px-5 justify-start" asChild>
					<Link to="/admin/settings" className="flex flex-col items-start gap-1">
						<span className="flex items-center gap-2 text-base font-semibold">
							<SlidersHorizontal className="size-5 shrink-0 text-brand" />
							Settings
						</span>
						<span className="text-sm font-normal text-muted-foreground">
							Site-wide practice flags and deploy options
						</span>
					</Link>
				</Button>
				<Button variant="outline" className="h-auto py-5 px-5 justify-start" asChild>
					<Link to="/admin/languages" className="flex flex-col items-start gap-1">
						<span className="flex items-center gap-2 text-base font-semibold">
							<Languages className="size-5 shrink-0 text-brand" />
							Languages
						</span>
						<span className="text-sm font-normal text-muted-foreground">
							Enable languages and view usage
						</span>
					</Link>
				</Button>
				<Button variant="outline" className="h-auto py-5 px-5 justify-start" asChild>
					<Link to="/admin/jobs" className="flex flex-col items-start gap-1">
						<span className="flex items-center gap-2 text-base font-semibold">
							<ListTodo className="size-5 shrink-0 text-brand" />
							Jobs
						</span>
						<span className="text-sm font-normal text-muted-foreground">
							Ingestion and import pipelines
						</span>
					</Link>
				</Button>
				<Button variant="outline" className="h-auto py-5 px-5 justify-start" asChild>
					<Link to="/admin/words" className="flex flex-col items-start gap-1">
						<span className="flex items-center gap-2 text-base font-semibold">
							<BookOpen className="size-5 shrink-0 text-brand" />
							Words
						</span>
						<span className="text-sm font-normal text-muted-foreground">
							Search and browse imported vocabulary
						</span>
					</Link>
				</Button>
				<Button variant="outline" className="h-auto py-5 px-5 justify-start" asChild>
					<Link to="/admin/sentences" className="flex flex-col items-start gap-1">
						<span className="flex items-center gap-2 text-base font-semibold">
							<MessageSquareText className="size-5 shrink-0 text-brand" />
							Sentences
						</span>
						<span className="text-sm font-normal text-muted-foreground">
							Search and browse imported sentences
						</span>
					</Link>
				</Button>
				<Button variant="outline" className="h-auto py-5 px-5 justify-start" asChild>
					<Link to="/admin/cloze-reports" className="flex flex-col items-start gap-1">
						<span className="flex items-center gap-2 text-base font-semibold">
							<Flag className="size-5 shrink-0 text-brand" />
							Cloze reports
						</span>
						<span className="text-sm font-normal text-muted-foreground">
							Review user-reported bad hints and sentences
						</span>
					</Link>
				</Button>
			</div>
		</div>
	)
}
