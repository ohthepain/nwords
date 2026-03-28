import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { GoogleAuthSection } from "~/components/google-auth-button"
import { Button } from "~/components/ui/button"
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { authClient } from "~/lib/auth-client"

export const Route = createFileRoute("/auth/register")({
	component: RegisterPage,
})

function RegisterPage() {
	const navigate = useNavigate()
	const [name, setName] = useState("")
	const [email, setEmail] = useState("")
	const [password, setPassword] = useState("")
	const [confirmPassword, setConfirmPassword] = useState("")
	const [error, setError] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault()
		setError(null)

		if (password !== confirmPassword) {
			setError("Passwords do not match")
			return
		}

		if (password.length < 8) {
			setError("Password must be at least 8 characters")
			return
		}

		setLoading(true)

		try {
			const result = await authClient.signUp.email({
				name,
				email,
				password,
			})

			if (result.error) {
				setError(result.error.message ?? "Registration failed")
				return
			}

			navigate({ to: "/dashboard" })
		} catch {
			setError("An unexpected error occurred")
		} finally {
			setLoading(false)
		}
	}

	return (
		<div className="flex-1 flex flex-col items-center justify-center px-6 gradient-subtle">
			<Link
				to="/"
				className="flex items-center gap-1.5 mb-8 group"
			>
				<span className="text-xl font-bold tracking-tight">nwords</span>
				<span className="text-xs text-muted-foreground font-mono opacity-60 group-hover:opacity-100 transition-opacity">
					.live
				</span>
			</Link>

			<Card className="w-full max-w-sm">
				<CardHeader className="text-center pb-4">
					<CardTitle className="text-xl font-bold">Create account</CardTitle>
					<CardDescription>Start measuring your vocabulary</CardDescription>
				</CardHeader>
				<form onSubmit={handleSubmit}>
					<CardContent className="space-y-4">
						<GoogleAuthSection />
						{error && (
							<div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2.5">
								{error}
							</div>
						)}
						<div className="space-y-2">
							<Label htmlFor="name">Name</Label>
							<Input
								id="name"
								type="text"
								placeholder="Your name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								required
								autoComplete="name"
								className="h-10"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="email">Email</Label>
							<Input
								id="email"
								type="email"
								placeholder="you@example.com"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								required
								autoComplete="email"
								className="h-10"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="password">Password</Label>
							<Input
								id="password"
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								required
								minLength={8}
								autoComplete="new-password"
								className="h-10"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="confirmPassword">Confirm password</Label>
							<Input
								id="confirmPassword"
								type="password"
								value={confirmPassword}
								onChange={(e) => setConfirmPassword(e.target.value)}
								required
								autoComplete="new-password"
								className="h-10"
							/>
						</div>
					</CardContent>
					<CardFooter className="flex flex-col gap-4 pt-2">
						<Button
							type="submit"
							className="w-full h-10"
							disabled={loading}
						>
							{loading ? "Creating account..." : "Create account"}
						</Button>
						<p className="text-sm text-muted-foreground">
							Already have an account?{" "}
							<Link
								to="/auth/login"
								className="text-foreground font-medium underline underline-offset-4 hover:text-brand transition-colors"
							>
								Sign in
							</Link>
						</p>
					</CardFooter>
				</form>
			</Card>
		</div>
	)
}
