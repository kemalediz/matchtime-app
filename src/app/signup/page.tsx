"use client";

/**
 * Public signup page — phone-number-first. We DM a 6-digit code via
 * WhatsApp, user enters it on the next screen, then lands in /onboarding.
 *
 * Existing email/Google sign-in flows at /login are untouched; this is
 * an additional entry point for new admins.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { startPhoneSignup, verifyPhoneSignup } from "@/app/actions/phone-signup";
import { signIn } from "next-auth/react";
import { Phone, Loader2, ShieldCheck } from "lucide-react";

export default function SignupPage() {
  const router = useRouter();
  const [stage, setStage] = useState<"enter" | "verify">("enter");
  const [phone, setPhone] = useState("+44");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleStart() {
    setBusy(true);
    try {
      const res = await startPhoneSignup({ phone, name });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Code sent via WhatsApp");
      setStage("verify");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify() {
    setBusy(true);
    try {
      const res = await verifyPhoneSignup({ phone, code, name });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // Bounce through the magic-link lander to get a session
      // established. Then route based on whether they're an existing
      // player (→ dashboard) or brand-new (→ /onboarding wizard for
      // new club). The action returns isExistingPlayer; we honour
      // that here instead of hard-coding /onboarding.
      await signIn("magic-link", {
        token: res.magicLinkToken,
        redirect: false,
      });
      if (res.isExistingPlayer) {
        toast.success("Welcome back!");
        router.push("/");
      } else {
        router.push("/onboarding");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-full bg-blue-100 mx-auto flex items-center justify-center mb-3">
            {stage === "enter" ? (
              <Phone className="w-5 h-5 text-blue-600" />
            ) : (
              <ShieldCheck className="w-5 h-5 text-blue-600" />
            )}
          </div>
          <h1 className="text-2xl font-bold text-slate-900">
            {stage === "enter" ? "Create your account" : "Check WhatsApp"}
          </h1>
          <p className="text-sm text-slate-500 mt-1.5">
            {stage === "enter"
              ? "We'll send a verification code by WhatsApp."
              : `Enter the 6-digit code we just sent to ${phone}.`}
          </p>
        </div>

        {stage === "enter" ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) handleStart();
            }}
          >
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Your name
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Kemal Ediz"
                className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Phone number
              </label>
              <input
                type="tel"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+44 7xxx xxxxxx"
                className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-slate-500 mt-1.5">
                Full international format. We&apos;ll send a WhatsApp message.
              </p>
            </div>
            <button
              type="submit"
              disabled={busy || phone.replace(/\D/g, "").length < 10 || !name.trim()}
              className="w-full h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {busy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Sending code…
                </>
              ) : (
                "Send code"
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
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
              className="w-full h-14 px-3 rounded-lg border-2 border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 text-center text-2xl tracking-[0.5em] font-mono"
            />
            <button
              type="submit"
              disabled={busy || code.length !== 6}
              className="w-full h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {busy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Verifying…
                </>
              ) : (
                "Verify &amp; continue"
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setStage("enter");
                setCode("");
              }}
              className="w-full text-sm text-slate-500 hover:text-slate-700"
            >
              ← Change phone number
            </button>
          </form>
        )}

        <p className="mt-6 text-center text-sm text-slate-500">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-blue-600 hover:text-blue-700">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
