"use client";

/**
 * The /play sign-up (slice L2): the fields (the shared PoolProfileFields),
 * the two ticks (18 or over; consent, unticked by default, with the policy
 * link), then the last step, which opens WhatsApp with the confirm message.
 * The browser runs the same validator the server does, so errors show at
 * once; the server's answer is the truth. No wording here (page-copy.ts).
 */
import { poolShareCopy } from "@/lib/i18n/pool-share";
import { useState } from "react";
import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { PoolProfileFields, type FieldErrorText } from "@/components/pool/pool-profile-fields";
import { PoolPageShell } from "@/components/pool/pool-page-shell";
import { useBrowserLang } from "@/lib/i18n/browser-lang";
import type { Lang } from "@/lib/i18n/lang";
import type { PoolErrorKey } from "@/lib/i18n/pool-play";
import { defaultPoolForm, toPoolPayload, type PoolFormValue } from "@/lib/pool/form-state";
import { fieldErrorKeys, poolPageCopy } from "@/lib/pool/page-copy";
import { validatePoolSignup, type PoolFieldErrors } from "@/lib/pool/profile-fields";
import { PRIVACY_PATH } from "@/lib/privacy-policy";

interface Confirm {
  code: string;
  prefill: string;
  waLink: string;
  earlyList: boolean;
}

export function PlaySignup({
  source,
  paused,
  invitedBy = null,
  earlyList,
}: {
  source: { campaignCode: string | null; referralCode: string | null };
  paused: boolean;
  /** Will a sign-up made now go on the early sign-up list? The server's
   *  switch (`signupGoesOnEarlyListForPage`), so the note says so only then. */
  earlyList: boolean;
  /** Slice G1: the friend whose link this is, when his privacy switch shows his name. */
  invitedBy?: string | null;
}) {
  const browserLang = useBrowserLang();
  const [chosen, setChosen] = useState<Lang | null>(null);
  const lang = chosen ?? browserLang;
  const copy = poolPageCopy(lang);

  // The form's language follows the page's until he picks one himself.
  const [form, setForm] = useState<PoolFormValue | null>(null);
  const value = form ?? defaultPoolForm(lang);
  const [adult, setAdult] = useState(false);
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<PoolFieldErrors>({});
  const [formError, setFormError] = useState<PoolErrorKey | null>(null);
  const [sending, setSending] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const keys = fieldErrorKeys(errors);
  const fieldText: FieldErrorText = Object.fromEntries(
    (["name", "area", "maxMiles", "availability", "sports"] as const).filter((k) => keys[k]).map((k) => [k, copy.errors[keys[k]!]]),
  );
  const hasErrors = Object.keys(errors).length > 0 || formError !== null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = { ...toPoolPayload(value), adult, consent, source: { c: source.campaignCode ?? undefined, ref: source.referralCode ?? undefined } };
    const local = validatePoolSignup(body);
    setFormError(null);
    if (!local.ok) {
      setErrors(local.errors);
      return;
    }
    setErrors({});
    setSending(true);
    try {
      const res = await fetch("/api/play/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as Partial<Confirm> & { ok?: boolean; reason?: string; errors?: PoolFieldErrors };
      if (data.ok && data.code && data.waLink && data.prefill) {
        setConfirm({ code: data.code, prefill: data.prefill, waLink: data.waLink, earlyList: !!data.earlyList });
        window.scrollTo({ top: 0 });
        return;
      }
      if (data.errors) setErrors(data.errors);
      else setFormError((["busy", "area-not-found", "paused", "unavailable"] as const).find((r) => r === data.reason) ?? "generic");
    } catch {
      setFormError("generic");
    } finally {
      setSending(false);
    }
  }

  if (confirm) {
    return (
      <PoolPageShell lang={lang} onLang={setChosen} copy={copy}>
        <h1 className="text-2xl font-bold text-slate-900">{copy.signup.confirmHeading}</h1>
        <p className="mt-3 text-slate-700">{copy.signup.confirmLead}</p>
        <a
          href={confirm.waLink}
          className="mt-6 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-3 text-base font-semibold text-white hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
        >
          <MessageCircle className="h-5 w-5" aria-hidden="true" />
          {copy.signup.openWhatsApp}
        </a>
        <dl className="mt-6 space-y-3 rounded-xl bg-slate-50 p-4 text-sm">
          <div>
            <dt className="font-semibold text-slate-900">{copy.signup.codeLabel}</dt>
            <dd className="mt-1 font-mono text-lg tracking-widest text-slate-900" data-testid="pool-code">
              {confirm.code}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-900">{copy.signup.messageLabel}</dt>
            <dd className="mt-1 text-slate-700" data-testid="pool-prefill">
              {confirm.prefill}
            </dd>
          </div>
        </dl>
        {confirm.earlyList && <p className="mt-4 text-slate-700">{copy.signup.confirmEarly}</p>}
        <p className="mt-2 text-sm text-slate-600">{copy.signup.confirmHelp}</p>
      </PoolPageShell>
    );
  }

  return (
    <PoolPageShell
      lang={lang}
      onLang={(l) => {
        setChosen(l);
        // Switching the page's language switches the messages' too; he can
        // still pick another one in the form.
        if (form) setForm({ ...form, language: l });
      }}
      copy={copy}
    >
      {invitedBy && (
        <p data-testid="pool-invited-by" className="mb-3 text-sm font-medium text-emerald-800">
          {poolShareCopy(lang).invitedBy(invitedBy)}
        </p>
      )}
      <h1 className="text-2xl font-bold text-slate-900">{copy.signup.heading}</h1>
      <p className="mt-3 text-slate-700">{copy.signup.lead}</p>
      <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{earlyList ? copy.signup.earlyNote : copy.signup.openNote}</p>
      <ol className="mt-5 list-decimal space-y-1 pl-5 text-sm text-slate-700">
        {copy.signup.howItWorks.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>

      {paused ? (
        <p role="status" className="mt-8 rounded-lg bg-slate-100 px-4 py-3 text-slate-800">
          {copy.signup.pausedNote}
        </p>
      ) : (
        <form onSubmit={submit} noValidate className="mt-8 space-y-8">
          {hasErrors && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800">
              {formError ? copy.errors[formError] : copy.errorSummary}
            </p>
          )}
          <PoolProfileFields value={value} onChange={setForm} copy={copy.fields} lang={lang} errors={fieldText} />

          <div className="space-y-4 border-t border-slate-200 pt-6">
            <Tick checked={adult} onChange={setAdult} label={copy.signup.adultLabel} error={keys.adult ? copy.errors.adult : undefined} />
            <Tick checked={consent} onChange={setConsent} label={copy.signup.consentLabel} error={keys.consent ? copy.errors.consent : undefined} />
            <p className="text-sm">
              <Link href={PRIVACY_PATH} className="text-blue-700 underline">
                {copy.signup.consentPolicy}
              </Link>
            </p>
          </div>

          <button
            type="submit"
            disabled={sending}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-base font-semibold text-white hover:bg-blue-700 disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 sm:w-auto"
          >
            {sending ? copy.signup.submitting : copy.signup.submit}
          </button>
        </form>
      )}
    </PoolPageShell>
  );
}

function Tick({ checked, onChange, label, error }: { checked: boolean; onChange: (v: boolean) => void; label: string; error?: string }) {
  const errId = `tick-${label.length}-${label.slice(0, 6).replace(/\W/g, "")}`;
  return (
    <div>
      <label className="flex items-start gap-3 text-sm text-slate-900">
        <input
          type="checkbox"
          className="mt-0.5 h-5 w-5 shrink-0"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          {...(error ? { "aria-invalid": true, "aria-describedby": errId } : {})}
        />
        <span>{label}</span>
      </label>
      {error && (
        <p id={errId} className="mt-1 pl-8 text-sm font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
