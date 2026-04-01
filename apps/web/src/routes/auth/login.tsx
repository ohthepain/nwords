import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowRight, Eye, EyeOff, Lock, Mail } from "lucide-react";
import { useState } from "react";
import { GoogleAuthSection } from "~/components/google-auth-button";
import { ThemeToggleButton } from "~/components/theme-toggle-button";
import { authClient } from "~/lib/auth-client";

const NWORDS_TAGLINE = "Measure, track, and expand your vocabulary in any language.";

export const Route = createFileRoute("/auth/login")({
  component: LoginPage,
});

function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await authClient.signIn.email({
        email,
        password,
      });

      if (result.error) {
        setError(result.error.message ?? "Sign in failed");
        return;
      }

      // Full page navigation ensures we land on /dashboard (avoids SPA routing quirks after auth).
      window.location.assign("/dashboard");
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
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
          <h1 className="text-white mb-4" style={{ fontSize: "2.5rem", fontWeight: 700, lineHeight: 1.2 }}>
            Welcome back
          </h1>
          <p className="text-zinc-400 max-w-xs" style={{ lineHeight: 1.6 }}>
            {NWORDS_TAGLINE}
          </p>
        </div>

        <div className="relative z-10 text-sm text-zinc-500">
          <Link to="/" className="hover:text-zinc-300 transition-colors underline underline-offset-2">
            ← Home
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
              <h2 className="text-foreground mb-2" style={{ fontSize: "1.875rem", fontWeight: 700 }}>
                Sign in
              </h2>
              <p className="text-muted-foreground">
                Don&apos;t have an account?{" "}
                <Link to="/auth/register" className="font-medium text-foreground underline underline-offset-4">
                  Register
                </Link>
              </p>
            </div>

            <GoogleAuthSection />

            <form onSubmit={handleSubmit} className="space-y-5 mt-6">
              {error && (
                <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5">
                  {error}
                </div>
              )}

              <div>
                <label htmlFor="login-email" className="block text-sm font-medium text-foreground mb-1.5">
                  Email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" size={17} />
                  <input
                    id="login-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    autoComplete="email"
                    className="w-full pl-10 pr-4 py-3 rounded-xl border border-input bg-background text-foreground placeholder:text-muted-foreground text-sm outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 transition-all"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="login-password" className="block text-sm font-medium text-foreground mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" size={17} />
                  <input
                    id="login-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    autoComplete="current-password"
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
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl text-primary-foreground font-semibold text-sm transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-70 bg-primary"
              >
                {loading ? (
                  <svg className="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <title>Loading</title>
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                ) : (
                  <>
                    <span>Sign in</span>
                    <ArrowRight size={16} />
                  </>
                )}
              </button>
            </form>

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
  );
}
