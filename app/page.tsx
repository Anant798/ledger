
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function Home() {
  const supabase = createClient();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignup, setIsSignup] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function handleGoogleLogin() {
    setLoading(true);
    setMessage("");

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setMessage(error.message);
      setLoading(false);
    }
  }

  async function handleEmailAuth(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    if (isSignup) {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      if (error) {
        setMessage(error.message);
      } else {
        setMessage("Account created! Check your email to confirm your account.");
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setMessage(error.message);
      } else {
        router.push("/dashboard");
        router.refresh();
      }
    }

    setLoading(false);
  }

  return (
    <main className="min-h-screen bg-[#F3EEDF] text-[#302B22] flex items-center justify-center p-6">
      <div className="w-full max-w-md border border-[#C9BDA6] bg-[#FAF7EF] shadow-xl">
        <div className="border-b border-[#D8CEBB] px-8 py-10 text-center">
          <p className="text-xs tracking-[0.35em] text-[#897653]">
            PERSONAL FINANCIAL LEDGER
          </p>

          <h1 className="mt-4 text-5xl font-serif tracking-wide">
            Ledger
          </h1>

          <div className="mx-auto my-5 h-px w-16 bg-[#A48A5E]" />

          <p className="text-sm text-[#756C5D]">
            Old-school money sense. Modern-day intelligence.
          </p>
        </div>

        <div className="px-8 py-8">
          <h2 className="text-2xl font-serif">
            {isSignup ? "Create your account" : "Welcome back"}
          </h2>

          <p className="mt-2 text-sm text-[#817766]">
            {isSignup
              ? "Start keeping your finances in order."
              : "Your financial story, organised in one place."}
          </p>

          <form onSubmit={handleEmailAuth} className="mt-7 space-y-4">
            <div>
              <label className="mb-2 block text-sm font-medium">
                Email address
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full border border-[#CFC3AE] bg-[#FFFDF8] px-4 py-3 text-sm outline-none transition focus:border-[#8B754F]"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">
                Password
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                className="w-full border border-[#CFC3AE] bg-[#FFFDF8] px-4 py-3 text-sm outline-none transition focus:border-[#8B754F]"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[#51452F] px-4 py-3 text-sm font-medium tracking-wide text-[#FAF7EF] transition hover:bg-[#6B593B] disabled:opacity-50"
            >
              {loading
                ? "Please wait..."
                : isSignup
                  ? "Create Account"
                  : "Sign In"}
            </button>
          </form>

          <div className="my-6 flex items-center gap-4">
            <div className="h-px flex-1 bg-[#D8CEBB]" />
            <span className="text-xs text-[#968A76]">OR</span>
            <div className="h-px flex-1 bg-[#D8CEBB]" />
          </div>

          <button
            onClick={handleGoogleLogin}
            disabled={loading}
            className="flex w-full items-center justify-center gap-3 border border-[#CFC3AE] bg-[#FFFDF8] px-4 py-3 text-sm transition hover:bg-[#F0EBDD] disabled:opacity-50"
          >
            <span className="text-lg font-bold text-[#4285F4]">G</span>
            Continue with Google
          </button>

          {message && (
            <p className="mt-5 border border-[#D8CEBB] bg-[#F0EBDD] p-3 text-sm text-[#65563D]">
              {message}
            </p>
          )}

          <p className="mt-7 text-center text-sm text-[#817766]">
            {isSignup
              ? "Already have an account?"
              : "New to Ledger?"}{" "}
            <button
              type="button"
              onClick={() => {
                setIsSignup(!isSignup);
                setMessage("");
              }}
              className="font-semibold text-[#715B37] underline underline-offset-4"
            >
              {isSignup ? "Sign in" : "Create an account"}
            </button>
          </p>
        </div>

        <div className="border-t border-[#D8CEBB] px-8 py-4 text-center">
          <p className="text-[10px] tracking-[0.2em] text-[#9A8D77]">
            YOUR MONEY. YOUR RECORD. YOUR CONTROL.
          </p>
        </div>
      </div>
    </main>
  );
}
