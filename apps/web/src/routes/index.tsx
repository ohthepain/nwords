import { Link, createFileRoute } from "@tanstack/react-router"
import { AppHeaderBrand } from "~/components/header"

export const Route = createFileRoute("/")({
	component: HomePage,
})

function HomePage() {
	return (
		<div className="flex-1 flex flex-col">
			{/* Nav */}
			<header className="border-b border-border/50 backdrop-blur-sm sticky top-0 z-10 bg-background/80">
				<div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-4">
					<AppHeaderBrand />
					<nav className="flex items-center gap-4">
						<Link
							to="/auth/login"
							className="text-sm text-muted-foreground hover:text-foreground transition-colors"
						>
							Sign in
						</Link>
						<Link
							to="/auth/register"
							className="text-sm bg-primary text-primary-foreground px-4 py-2 rounded-md font-medium hover:opacity-90 transition-opacity"
						>
							Get started
						</Link>
					</nav>
				</div>
			</header>

			{/* Hero */}
			<main className="flex-1 flex flex-col items-center justify-center px-6 gradient-subtle">
				<div className="max-w-2xl text-center py-20">
					<div className="inline-flex items-center gap-2 text-xs font-mono text-muted-foreground bg-muted rounded-full px-3 py-1.5 mb-8">
						<span className="size-1.5 rounded-full bg-known animate-pulse" />
						Precision vocabulary measurement
					</div>

					<h1 className="text-5xl sm:text-6xl font-bold tracking-tight mb-6 leading-[1.1]">
						Know your
						<br />
						<span className="text-brand">vocabulary.</span>
					</h1>

					<p className="text-lg text-muted-foreground mb-4 leading-relaxed max-w-lg mx-auto">
						A precision instrument for measuring, tracking, and expanding your vocabulary in any
						language.
					</p>
					<p className="text-sm text-muted-foreground mb-10 max-w-md mx-auto">
						Test against the 10,000 most important words. Find gaps. Fill them. Track your CEFR
						level with scientific accuracy.
					</p>

					<div className="flex flex-wrap items-center justify-center gap-3">
						<Link
							to="/auth/register"
							className="bg-primary text-primary-foreground px-6 py-3 rounded-md text-sm font-medium hover:opacity-90 transition-all active:scale-[0.98]"
						>
							Start measuring
						</Link>
						<Link
							to="/practice"
							className="border border-border px-6 py-3 rounded-md text-sm font-medium hover:bg-accent transition-all"
						>
							Try practice
						</Link>
						<a
							href="#how-it-works"
							className="border border-border px-6 py-3 rounded-md text-sm font-medium hover:bg-accent transition-all"
						>
							How it works
						</a>
					</div>
				</div>

				{/* Stats */}
				<div className="w-full max-w-3xl mx-auto pb-20">
					<div className="grid grid-cols-3 gap-6 text-center">
						<div className="space-y-1">
							<div className="text-4xl font-bold font-mono tracking-tighter">10k</div>
							<div className="text-xs text-muted-foreground uppercase tracking-wider">
								words per language
							</div>
						</div>
						<div className="space-y-1 border-x border-border px-4">
							<div className="text-4xl font-bold font-mono tracking-tighter">A1–C2</div>
							<div className="text-xs text-muted-foreground uppercase tracking-wider">
								CEFR tracking
							</div>
						</div>
						<div className="space-y-1">
							<div className="text-4xl font-bold font-mono tracking-tighter">42+</div>
							<div className="text-xs text-muted-foreground uppercase tracking-wider">
								languages
							</div>
						</div>
					</div>
				</div>
			</main>

			{/* How it works */}
			<section id="how-it-works" className="border-t border-border py-24 px-6">
				<div className="max-w-4xl mx-auto">
					<div className="text-center mb-16">
						<p className="text-xs font-mono text-muted-foreground uppercase tracking-widest mb-3">
							Methodology
						</p>
						<h2 className="text-3xl font-bold tracking-tight">Precision vocabulary measurement</h2>
					</div>
					<div className="grid grid-cols-1 md:grid-cols-3 gap-10">
						<div className="space-y-4">
							<div className="flex items-center gap-3">
								<span className="flex items-center justify-center size-8 rounded-md bg-muted text-sm font-mono font-bold">
									01
								</span>
								<h3 className="font-semibold text-lg">Zero-in</h3>
							</div>
							<p className="text-sm text-muted-foreground leading-relaxed pl-11">
								Quick multiple-choice tests rapidly narrow down your vocabulary level using binary
								search. Know your number in minutes, not hours.
							</p>
						</div>
						<div className="space-y-4">
							<div className="flex items-center gap-3">
								<span className="flex items-center justify-center size-8 rounded-md bg-muted text-sm font-mono font-bold">
									02
								</span>
								<h3 className="font-semibold text-lg">Map the gaps</h3>
							</div>
							<p className="text-sm text-muted-foreground leading-relaxed pl-11">
								A heatmap of your vocabulary reveals exactly which words you're missing. See the
								holes. Prioritize what matters most.
							</p>
						</div>
						<div className="space-y-4">
							<div className="flex items-center gap-3">
								<span className="flex items-center justify-center size-8 rounded-md bg-muted text-sm font-mono font-bold">
									03
								</span>
								<h3 className="font-semibold text-lg">Fill precisely</h3>
							</div>
							<p className="text-sm text-muted-foreground leading-relaxed pl-11">
								Translation tests with real sentences. AI-powered spaced repetition. Voice mode.
								Every session is a precision strike.
							</p>
						</div>
					</div>
				</div>
			</section>

			{/* Footer */}
			<footer className="border-t border-border py-8 px-6">
				<div className="max-w-6xl mx-auto flex items-center justify-between text-xs text-muted-foreground">
					<div className="flex items-center gap-1.5">
						<span className="font-semibold text-foreground">nwords</span>
						<span className="font-mono opacity-50">.live</span>
					</div>
					<span className="font-mono">A precision vocabulary tool.</span>
				</div>
			</footer>
		</div>
	)
}
