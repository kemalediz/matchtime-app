"use client";

/**
 * The pool's last step (slice L3): open WhatsApp with the confirm message,
 * the code and the message shown as well. The same wording as the /play
 * sign-up's confirm screen (`copy.signup.*`), for a member with no number on
 * his account. Nothing happens until he sends it himself.
 */
import { MessageCircle } from "lucide-react";
import type { PoolPlayCopy } from "@/lib/i18n/pool-play";

export function PoolWhatsAppStep({ copy, step, earlyList }: { copy: PoolPlayCopy; step: { code: string; prefill: string; waLink: string }; earlyList: boolean }) {
  return (
    <div>
      <p className="text-slate-700">{copy.signup.confirmLead}</p>
      <a
        href={step.waLink}
        className="mt-4 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-3 text-base font-semibold text-white hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
      >
        <MessageCircle className="h-5 w-5" aria-hidden="true" />
        {copy.signup.openWhatsApp}
      </a>
      <dl className="mt-4 space-y-3 rounded-xl bg-slate-50 p-4 text-sm">
        <div>
          <dt className="font-semibold text-slate-900">{copy.signup.codeLabel}</dt>
          <dd className="mt-1 font-mono text-lg tracking-widest text-slate-900" data-testid="pool-code">
            {step.code}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">{copy.signup.messageLabel}</dt>
          <dd className="mt-1 break-words text-slate-700" data-testid="pool-prefill">
            {step.prefill}
          </dd>
        </div>
      </dl>
      {earlyList && <p className="mt-3 text-sm text-slate-700">{copy.signup.confirmEarly}</p>}
      <p className="mt-2 text-sm text-slate-600">{copy.signup.confirmHelp}</p>
    </div>
  );
}
