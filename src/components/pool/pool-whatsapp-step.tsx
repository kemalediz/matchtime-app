"use client";

/**
 * The pool's last step: open WhatsApp with the confirm message. Used by the
 * /play confirm screen (slice L2) and a member with no number on his account
 * (slice L3). Nothing happens until he sends it himself, so (2026-10-31, two
 * in ten never sent it) the order is: one short line, the big WhatsApp
 * button, how long the code works, then the code and the message as well.
 */
import { MessageCircle } from "lucide-react";
import type { PoolPlayCopy } from "@/lib/i18n/pool-play";

export function PoolWhatsAppStep({ copy, step, earlyList }: { copy: PoolPlayCopy; step: { code: string; prefill: string; waLink: string }; earlyList: boolean }) {
  return (
    <div data-testid="pool-whatsapp-step">
      <p className="text-slate-700">{copy.signup.confirmLead}</p>
      <PoolWhatsAppButton href={step.waLink} label={copy.signup.openWhatsApp} className="mt-4" />
      <p className="mt-3 text-sm font-medium text-slate-800">{copy.signup.confirmHelp}</p>
      <dl className="mt-5 space-y-3 rounded-xl bg-slate-50 p-4 text-sm">
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
    </div>
  );
}

/** The green "send it on WhatsApp" button: full width on a phone. */
export function PoolWhatsAppButton({ href, label, className = "" }: { href: string; label: string; className?: string }) {
  return (
    <a
      href={href}
      className={`inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-6 py-4 text-lg font-semibold text-white shadow-sm hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 sm:w-auto ${className}`}
    >
      <MessageCircle className="h-6 w-6" aria-hidden="true" />
      {label}
    </a>
  );
}
