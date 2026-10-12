"use client";

/**
 * Sign in. WhatsApp is the only way in (2026-10-11): enter your phone
 * number, get a 6 digit code on WhatsApp, enter it.
 *
 * Why: an organiser who signed up with a phone number has no password and
 * no Google account, and this page used to offer only those two. The only
 * way back in was to "sign up" again, which nobody would guess.
 *
 * Signing in never creates an account and never asks for a name. A number
 * with no account is told so only AFTER a correct code, so this page
 * cannot be used to test whether somebody else's number is on MatchTime
 * (see verifyPhoneSignIn).
 *
 * `/login?via=google` also shows a Google button. It is the platform
 * owner's fallback for when the WhatsApp bot is down and no code can be
 * sent; nothing links to it, and it only signs in a Google account that
 * is already linked to a user (src/lib/google-signin-gate.ts).
 */

import { Suspense, useRef, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { startPhoneSignIn, verifyPhoneSignIn } from "@/app/actions/phone-signup";
import { safeCallbackPath } from "@/lib/safe-callback";
import { t } from "@/lib/i18n/t";
import { useBrowserLang } from "@/lib/i18n/browser-lang";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/";
  const claimed = searchParams.get("claimed") === "1";
  // Sent here by an expired signed link (/r, src/lib/expired-link.ts),
  // which is carried as `link` and read by the server only AFTER a correct
  // code, and only for the person it was minted for. Nothing about it is
  // known here, so the notice is in the browser's own language.
  const linkExpired = searchParams.get("expired") === "1";
  const link = searchParams.get("link");
  const expiredNotice = t(useBrowserLang()).login_link_expired;
  const viaGoogle = searchParams.get("via") === "google";
  const urlError = searchParams.get("error");

  const [stage, setStage] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("+44");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [noAccount, setNoAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  async function handleSendCode() {
    if (submitting.current) return;
    submitting.current = true;
    setError("");
    setNoAccount(false);
    setBusy(true);
    try {
      const res = await startPhoneSignIn({ phone });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setCode("");
      setStage("code");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function handleVerify() {
    if (submitting.current) return;
    submitting.current = true;
    setError("");
    setBusy(true);
    // Stays busy on success: the next page is still loading.
    let leaving = false;
    try {
      const res = await verifyPhoneSignIn({ phone, code, callbackUrl, link });
      if (!res.ok) {
        if (res.noAccount) {
          // The code is spent and there is nobody to sign in: back to
          // the start, with the way to sign up.
          setNoAccount(true);
          setStage("phone");
          setCode("");
        } else {
          setError(res.error);
        }
        return;
      }
      const result = await signIn("magic-link", { token: res.magicLinkToken, redirect: false });
      if (result?.error || !result?.ok) {
        setError("Something went wrong. Please try again.");
        return;
      }
      leaving = true;
      // The server chose this path: a same-site callbackUrl, or the
      // usual landing page for this user.
      router.push(res.nextPath);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      if (!leaving) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }

  const inputClass =
    "w-full h-11 px-3 rounded-lg border border-slate-200 text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent";
  const whatsappButtonClass =
    "w-full h-12 rounded-lg bg-green-600 hover:bg-green-700 text-white font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2";

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-sm w-full">
        <div className="text-center mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/matchtime-icon.svg" alt="" className="w-14 h-14 rounded-2xl mx-auto mb-3 shadow-md" />
          <h1 className="text-2xl font-bold text-slate-800">
            Match<span className="text-blue-600">Time</span>
          </h1>
          <p className="text-sm text-slate-500 mt-1">Sign in to your account</p>
        </div>

        {linkExpired && (
          <div
            role="status"
            data-testid="login-link-expired"
            className="mb-5 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900"
          >
            {expiredNotice}
          </div>
        )}

        {claimed && (
          <div className="mb-5 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
            ✓ Player record linked. Sign in again to access your stats.
          </div>
        )}

        {noAccount && (
          <div role="alert" className="mb-5 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900">
            There is no MatchTime account for this number.{" "}
            <Link href="/signup" className="font-semibold underline">
              Sign up to create one
            </Link>
            .
          </div>
        )}

        {stage === "phone" ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) handleSendCode();
            }}
          >
            <div>
              <label htmlFor="phone" className="block text-sm font-medium text-slate-700 mb-1.5">
                Phone number
              </label>
              <input
                id="phone"
                type="tel"
                required
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+44 7xxx xxxxxx"
                className={inputClass}
              />
              <p className="text-xs text-slate-500 mt-1.5">
                We&apos;ll send a 6 digit code to your WhatsApp.
              </p>
            </div>

            {error && (
              <div role="alert" className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>
            )}

            <button
              type="submit"
              disabled={busy || phone.replace(/\D/g, "").length < 10}
              className={whatsappButtonClass}
            >
              {busy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Sending code…
                </>
              ) : (
                "Sign in with WhatsApp"
              )}
            </button>
          </form>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) handleVerify();
            }}
          >
            <p className="text-sm text-slate-600 text-center">
              Enter the 6 digit code we sent to {phone} on WhatsApp.
            </p>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="6 digit code"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
              className="w-full h-14 px-3 rounded-lg border-2 border-slate-200 focus:outline-none focus:ring-2 focus:ring-green-500 text-center text-2xl tracking-[0.5em] font-mono"
            />

            {error && (
              <div role="alert" className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>
            )}

            <button type="submit" disabled={busy || code.length !== 6} className={whatsappButtonClass}>
              {busy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Signing in…
                </>
              ) : (
                "Sign in"
              )}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setStage("phone");
                setCode("");
                setError("");
              }}
              className="w-full text-sm text-slate-500 hover:text-slate-700 disabled:opacity-60"
            >
              Use a different number
            </button>
          </form>
        )}

        {viaGoogle && (
          <>
            <div className="relative my-5">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-slate-200" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-white px-2 text-xs uppercase tracking-wider text-slate-400">Or</span>
              </div>
            </div>

            {urlError === "not-linked" && (
              <div role="alert" className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm">
                That Google account is not linked to a MatchTime account.
              </div>
            )}

            <button
              type="button"
              onClick={() => signIn("google", { callbackUrl: safeCallbackPath(callbackUrl) ?? "/" })}
              className="flex items-center justify-center gap-3 w-full h-11 bg-white border-2 border-slate-200 rounded-lg font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
              Sign in with Google
            </button>
          </>
        )}

        <p className="mt-6 text-center text-sm text-slate-500">
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="font-medium text-blue-600 hover:text-blue-700">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-slate-900">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
