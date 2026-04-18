import { Link, createFileRoute } from "@tanstack/react-router"
import { ArrowRight, Eye, EyeOff, Lock } from "lucide-react"
import { useState } from "react"
import { ThemeToggleButton } from "~/components/theme-toggle-button"
import { authClient } from "~/lib/auth-client"

type ResetSearch = {
	token?: string
	error?: string
}

export const Route = createFileRoute("/auth/reset-password")({
	component: ResetPasswordPage,
	validateSearch: (search: Record<string, unknown>): ResetSearch => ({
		token:
			typeof search.token === "string" && search.token.trim() ? search.token.trim() : undefined,
		error: typeof search.error === "string" ? search.error : undefined,
	}),
})

const MIN_PASSWORD = 8

function ResetPasswordPage() {
	const { token, error } = Route.useSearch()
	const [newPassword, setNewPassword] = useState("")
	const [showPassword, setShowPassword] = useState(false)
	const [formError, setFormError] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)
	const blocked = error === "INVALID_TOKEN" || !token

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault()
		setFormError(null)
		if (!token) {
			setFormError("Reset link is missing or invalid.")
			return
		}
		if (newPassword.length < MIN_PASSWORD) {
			setFormError(`Password must be at least ${MIN_PASSWORD} characters`)
			return
		}
		setLoading(true)
		try {
			const result = await authClient.resetPassword({
				newPassword,
				token,
			})
			if (result.error) {
				setFormError(result.error.message ?? "Could not reset password")
				return
			}
			window.location.assign("/auth/login")
		} catch {
			setFormError("An unexpected error occurred")
		} finally {
			setLoading(false)
		}
	}

	return (
		<div className="min-h-screen w-full flex">
			<div className="hidden lg:flex lg:w-1/3 flex-col justify-between p-12 relative overflow-hidden bg-zinc-950 text-white">
				<div className="absolute -top-24 -left-24 w-96 h-96 rounded-full opacity-5 bg-white" />
				<div className="absolute -bottom-32 -right-16 size-[28rem] rounded-full opacity-5 bg-white" />

				<Link
					to="/"
					className="relative z-10 flex items-center gap-3 text-sm text-zinc-400 hover:text-white transition-colors"
				>
					<span className="font-semibold text-lg tracking-tight text-white">nwords</span>
					<span className="text-xs font-mono text-zinc-500">.live</span>
				</Link>

				<div className="relative z-10">
					<h1
						className="text-white mb-4"
						style={{ fontSize: "2.5rem", fontWeight: 700, lineHeight: 1.2 }}
					>
						New password
					</h1>
					<p className="text-zinc-400 max-w-xs" style={{ lineHeight: 1.6 }}>
						Choose a strong password you have not used elsewhere.
					</p>
				</div>

				<div className="relative z-10 text-sm text-zinc-500">
					<Link
						to="/auth/login"
						className="hover:text-zinc-300 transition-colors underline underline-offset-2"
					>
						← Back to sign in
					</Link>
				</div>
			</div>

			<div className="flex-1 flex min-w-0">
				<div className="flex-1 flex items-center justify-center bg-background px-6 py-12">
					<div className="w-full max-w-md">
						<div className="flex lg:hidden items-center justify-between gap-3 mb-10">
							<Link to="/" className="flex items-center gap-2">
								<span className="font-semibold text-lg text-foreground">nwords</span>
								<span className="text-xs font-mono text-muted-foreground">.live</span>
							</Link>
							<ThemeToggleButton />
						</div>

						<div className="mb-8">
							<h2
								className="text-foreground mb-2"
								style={{ fontSize: "1.875rem", fontWeight: 700 }}
							>
								Reset password
							</h2>
							<p className="text-muted-foreground">
								Remembered it?{" "}
								<Link
									to="/auth/login"
									className="font-medium text-foreground underline underline-offset-4"
								>
									Sign in
								</Link>
							</p>
						</div>

						{blocked ? (
							<div className="space-y-4">
								<div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5">
									This reset link is invalid or has expired. Request a new one from the sign-in
									page.
								</div>
								<Link
									to="/auth/login"
									className="inline-flex items-center justify-center w-full py-3.5 rounded-xl text-primary-foreground font-semibold text-sm bg-primary text-center"
								>
									Back to sign in
								</Link>
							</div>
						) : (
							<form onSubmit={handleSubmit} className="space-y-5">
								{formError && (
									<div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5">
										{formError}
									</div>
								)}

								<div>
									<label
										htmlFor="reset-new-password"
										className="block text-sm font-medium text-foreground mb-1.5"
									>
										New password
									</label>
									<div className="relative">
										<Lock
											className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
											size={17}
										/>
										<input
											id="reset-new-password"
											type={showPassword ? "text" : "password"}
											value={newPassword}
											onChange={(e) => setNewPassword(e.target.value)}
											placeholder="••••••••"
											required
											minLength={MIN_PASSWORD}
											autoComplete="new-password"
											className="w-full pl-10 pr-11 py-3 rounded-xl border border-input bg-background text-foreground placeholder:text-muted-foreground text-sm outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 transition-all"
										/>
										<button
											type="button"
											onClick={() => setShowPassword(!showPassword)}
											className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
											aria-label={showPassword ? "Hide password" : "Show password"}
										>
											{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
										</button>
									</div>
									<p className="text-xs text-muted-foreground mt-1.5">
										At least {MIN_PASSWORD} characters
									</p>
								</div>

								<button
									type="submit"
									disabled={loading}
									className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl text-primary-foreground font-semibold text-sm transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-70 bg-primary"
								>
									{loading ? (
										<svg
											className="animate-spin"
											width="18"
											height="18"
											viewBox="0 0 24 24"
											fill="none"
											aria-hidden
										>
											<title>Loading</title>
											<circle
												cx="12"
												cy="12"
												r="10"
												stroke="currentColor"
												strokeWidth="3"
												strokeOpacity="0.3"
											/>
											<path
												d="M12 2a10 10 0 0 1 10 10"
												stroke="currentColor"
												strokeWidth="3"
												strokeLinecap="round"
											/>
										</svg>
									) : (
										<>
											<span>Update password</span>
											<ArrowRight size={16} />
										</>
									)}
								</button>
							</form>
						)}

						<p className="text-center mt-8">
							<Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
								← Back to home
							</Link>
						</p>
					</div>
				</div>
				<div className="hidden lg:flex lg:w-64 lg:shrink-0 lg:flex-col lg:items-end lg:pt-6 lg:pr-6">
					<ThemeToggleButton />
				</div>
			</div>
		</div>
	)
}
