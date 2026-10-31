"use client";

/**
 * The /play reminder (2026-10-31): a returning visitor whose sign-up still
 * waits for its WhatsApp code sees this above the form, with the same
 * WhatsApp button. Shown only after the server said "waiting"
 * (`pending-signup.ts`), so a confirmed or run-out sign-up never gets it.
 */
import type { PoolPlayCopy } from "@/lib/i18n/pool-play";
import type { Lang } from "@/lib/i18n/lang";
import type { PendingSignup } from "@/lib/pool/pending-signup";
import { PoolWhatsAppButton } from "./pool-whatsapp-step";

function untilText(lang: Lang, ms: number): string {
  return new Intl.DateTimeFormat(lang === "tr" ? "tr-TR" : "en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  }).format(new Date(ms));
}

export function PoolPendingReminder({ copy, lang, pending }: { copy: PoolPlayCopy; lang: Lang; pending: PendingSignup }) {
  return (
    <section
      data-testid="pool-reminder"
      aria-labelledby="pool-reminder-heading"
      className="mb-8 rounded-2xl border-2 border-emerald-600 bg-emerald-50 p-5"
    >
      <h2 id="pool-reminder-heading" className="text-xl font-bold text-slate-900">
        {copy.signup.reminderHeading}
      </h2>
      <p className="mt-2 text-slate-800">{copy.signup.reminderLead}</p>
      <PoolWhatsAppButton href={pending.waLink} label={copy.signup.openWhatsApp} className="mt-4" />
      <p className="mt-3 text-sm text-slate-700">
        {copy.signup.codeLabel}: <span className="font-mono font-semibold tracking-widest text-slate-900" data-testid="pool-reminder-code">{pending.code}</span>
      </p>
      <p className="mt-1 text-sm text-slate-700" data-testid="pool-reminder-until">
        {copy.signup.reminderUntil(untilText(lang, pending.expiresAt))}
      </p>
      <p className="mt-1 text-sm text-slate-700">{copy.signup.reminderNoForm}</p>
    </section>
  );
}
