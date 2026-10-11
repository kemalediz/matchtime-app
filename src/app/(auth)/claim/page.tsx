"use client";

/**
 * Post-signin "claim my player account" wizard.
 *
 * Anyone signing into MatchTime via Google or email/password lands
 * here on first sign-in (when they have no memberships and no
 * verified phone yet). Two paths:
 *
 *   1. "I'm an existing player" — phone OTP → server merges this
 *      orphan User into the bot-tracked player record. Then we
 *      sign them out so the JWT re-issues against the merged user.
 *      They sign back in via Google → land on dashboard with all
 *      their stats.
 *
 *   2. "I'm starting a new club" — skip the merge, continue to
 *      /welcome (existing onboarding).
 *
 * If they verify a phone that DOESN'T match any existing User, we
 * just store the phone on this user and route them to /welcome to
 * continue as a new admin. So the OTP is always useful (claims OR
 * just stamps the phone) — never a wasted step.
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { startClaimAccount, verifyClaimAccount } from "@/app/actions/claim";
import { ArrowRight, Loader2, Phone, CheckCircle2 } from "lucide-react";

type Step = "intro" | "phone" | "code";

export default function ClaimPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("intro");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const submitting = useRef(false);

  async function sendCode() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const r = await startClaimAccount(phone);
      if (!r.ok) {
        setError(r.error);
      } else {
        setInfo("Code sent. Check your WhatsApp.");
        setStep("code");
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function verify() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setInfo("");
    // Stays busy on success: the next page is still loading.
    let leaving = false;
    try {
      const r = await verifyClaimAccount({ phone, code });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      if (r.claimed) {
        // Sign out + back through Google so the JWT re-issues
        // against the merged user. callbackUrl=/ lands them on the
        // dashboard with all their stats once they re-auth.
        await signOut({ callbackUrl: "/login?claimed=1" });
        leaving = true;
      } else {
        // No existing player to merge — phone is now stamped on
        // this user. Continue as a new admin.
        leaving = true;
        router.push("/welcome");
      }
    } finally {
      if (!leaving) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }

  function skip() {
    router.push("/welcome");
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-10 bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
        {step === "intro" && (
          <>
            <div className="text-center mb-6">
              <h1 className="text-2xl font-bold text-slate-800">Welcome to MatchTime</h1>
              <p className="text-sm text-slate-500 mt-2">
                Are you already a player at a club using MatchTime, or are you
                starting a fresh club?
              </p>
            </div>

            <div className="space-y-3">
              <button
                onClick={() => setStep("phone")}
                className="w-full p-4 rounded-xl border border-slate-200 hover:border-blue-400 hover:bg-blue-50/40 text-left transition-all flex items-start gap-3"
              >
                <div className="shrink-0 w-9 h-9 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center">
                  <Phone className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-slate-800">I&apos;m an existing player</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Verify your phone and we&apos;ll link this sign-in to your
                    existing player record (stats, ratings, MoM history).
                  </p>
                </div>
                <ArrowRight className="w-4 h-4 text-slate-400 shrink-0 mt-3" />
              </button>

              <button
                onClick={skip}
                className="w-full p-4 rounded-xl border border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-left transition-all flex items-start gap-3"
              >
                <div className="shrink-0 w-9 h-9 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center font-semibold">
                  +
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-slate-800">I&apos;m starting a new club</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Skip the player link and set up a brand-new organisation.
                  </p>
                </div>
                <ArrowRight className="w-4 h-4 text-slate-400 shrink-0 mt-3" />
              </button>
            </div>
          </>
        )}

        {step === "phone" && (
          <>
            <div className="text-center mb-6">
              <h1 className="text-2xl font-bold text-slate-800">Verify your phone</h1>
              <p className="text-sm text-slate-500 mt-2">
                We&apos;ll send a 6-digit code to your WhatsApp. Use the same
                number your club admin has on file.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Phone number
                </label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+44 7700 900000"
                  autoFocus
                  className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-slate-400 mt-1">
                  Full international format, including the leading +.
                </p>
              </div>

              {error && (
                <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>
              )}

              <button
                onClick={sendCode}
                disabled={busy || !phone.trim()}
                className="w-full h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                Send verification code
              </button>

              <button
                onClick={() => {
                  setStep("intro");
                  setError("");
                }}
                className="w-full text-sm text-slate-500 hover:text-slate-700 mt-2"
              >
                ← back
              </button>
            </div>
          </>
        )}

        {step === "code" && (
          <>
            <div className="text-center mb-6">
              <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto mb-3" />
              <h1 className="text-2xl font-bold text-slate-800">Enter the code</h1>
              <p className="text-sm text-slate-500 mt-2">
                We&apos;ve DM&apos;d a 6-digit code to{" "}
                <span className="font-mono text-slate-700">{phone}</span> on
                WhatsApp. It expires in 10 minutes.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Verification code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  autoFocus
                  className="w-full h-11 px-3 rounded-lg border border-slate-200 text-center font-mono text-lg tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {info && !error && (
                <div className="p-3 bg-blue-50 text-blue-700 rounded-lg text-sm">{info}</div>
              )}
              {error && (
                <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>
              )}

              <button
                onClick={verify}
                disabled={busy || code.length !== 6}
                className="w-full h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                Verify and continue
              </button>

              <button
                onClick={() => {
                  setStep("phone");
                  setCode("");
                  setError("");
                }}
                className="w-full text-sm text-slate-500 hover:text-slate-700 mt-2"
              >
                ← use a different number
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
