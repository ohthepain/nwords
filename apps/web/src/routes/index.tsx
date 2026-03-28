import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/")({
	component: HomePage,
})

function HomePage() {
	return (
		<div className="flex-1 flex flex-col">
			{/* Nav */}
			<header className="border-b border-border">
				<div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
					<div className="flex items-center gap-2">
						<span className="text-xl font-semibold tracking-tight">nwords</span>
						<span className="text-xs text-muted-foreground font-mono">.live</span>
					</div>
					<nav className="flex items-center gap-6">
						<a
							href="/auth/login"
							className="text-sm text-muted-foreground hover:text-foreground transition-colors"
						>
							Sign in
						</a>
						<a
							href="/auth/register"
							className="text-sm bg-primary text-primary-foreground px-4 py-2 rounded-md hover:opacity-90 transition-opacity"
						>
							Get started
						</a>
					</nav>
				</div>
			</header>

			{/* Hero */}
			<main className="flex-1 flex items-center justify-center px-6">
				<div className="max-w-2xl text-center">
					<h1 className="text-5xl font-bold tracking-tight mb-6">
						Know your vocabulary.
					</h1>
					<p className="text-lg text-muted-foreground mb-4 leading-relaxed">
						A precision instrument for measuring, tracking, and expanding your
						vocabulary in any language. Not a game. A tool.
					</p>
					<p className="text-sm text-muted-foreground mb-10">
						Test against the 10,000 most important words. Find gaps. Fill them.
						Track your CEFR level with scientific accuracy.
					</p>

					<div className="flex items-center justify-center gap-4">
						<a
							href="/auth/register"
							className="bg-primary text-primary-foreground px-6 py-3 rounded-md text-sm font-medium hover:opacity-90 transition-opacity"
						>
							Start measuring
						</a>
						<a
							href="#how-it-works"
							className="border border-border px-6 py-3 rounded-md text-sm font-medium hover:bg-accent transition-colors"
						>
							How it works
						</a>
					</div>

					{/* Stats preview */}
					<div className="mt-20 grid grid-cols-3 gap-8 text-left">
						<div>
							<div className="text-3xl font-bold font-mono">10,000</div>
							<div className="text-sm text-muted-foreground mt-1">
								words ranked per language
							</div>
						</div>
						<div>
							<div className="text-3xl font-bold font-mono">A1→C2</div>
							<div className="text-sm text-muted-foreground mt-1">
								CEFR level tracking
							</div>
						</div>
						<div>
							<div className="text-3xl font-bold font-mono">42+</div>
							<div className="text-sm text-muted-foreground mt-1">
								languages supported
							</div>
						</div>
					</div>
				</div>
			</main>

			{/* How it works */}
			<section id="how-it-works" className="border-t border-border py-20 px-6">
				<div className="max-w-4xl mx-auto">
					<h2 className="text-2xl font-bold mb-12 text-center">
						Precision vocabulary measurement
					</h2>
					<div className="grid grid-cols-1 md:grid-cols-3 gap-8">
						<div className="space-y-3">
							<div className="text-sm font-mono text-muted-foreground">01</div>
							<h3 className="font-semibold">Zero-in</h3>
							<p className="text-sm text-muted-foreground leading-relaxed">
								Quick multiple-choice tests rapidly narrow down your vocabulary
								level using binary search. Know your number in minutes.
							</p>
						</div>
						<div className="space-y-3">
							<div className="text-sm font-mono text-muted-foreground">02</div>
							<h3 className="font-semibold">Map the gaps</h3>
							<p className="text-sm text-muted-foreground leading-relaxed">
								A heatmap of your vocabulary reveals exactly which words you're
								missing. See the holes. Prioritize what matters.
							</p>
						</div>
						<div className="space-y-3">
							<div className="text-sm font-mono text-muted-foreground">03</div>
							<h3 className="font-semibold">Fill precisely</h3>
							<p className="text-sm text-muted-foreground leading-relaxed">
								Translation tests with real sentences. AI-powered spaced
								repetition. Voice mode. Every session is a precision strike.
							</p>
						</div>
					</div>
				</div>
			</section>

			{/* Footer */}
			<footer className="border-t border-border py-8 px-6">
				<div className="max-w-6xl mx-auto flex items-center justify-between text-sm text-muted-foreground">
					<span>nwords.live</span>
					<span>The anti-Duolingo.</span>
				</div>
			</footer>
		</div>
	)
}
