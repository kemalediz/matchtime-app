"use client";

/**
 * The /play sign-up (slice L2): the fields (the shared PoolProfileFields),
 * the two ticks (18 or over; consent, unticked by default, with the policy
 * link), then the last step, which opens WhatsApp with the confirm message.
 * The browser runs the same validator the server does, so errors show at
 * once; the server's answer is the truth. No wording here (page-copy.ts).
 * What he types is kept as a draft in this tab (signup-draft.ts) until the
 * sign-up is sent, and the policy opens in a new tab, so nothing is lost.
 * The POST itself is `sendPoolSignup`, which also counts the sign-up in
 * Vercel Web Analytics (one `pool_signup` event, no personal data).
 *
 * THE REMINDER (2026-10-31): a sent sign-up is remembered in this browser
 * (`pending-signup.ts`, the code and its WhatsApp link only). On a later
 * visit the page asks the server whether it still waits; only then is the
 * reminder shown above the form. Confirmed, run out or gone: forgotten, and
 * for a code that no longer works one line says to fill in the form again.
 */
import { poolShareCopy } from "@/lib/i18n/pool-share";
import { useEffect, useState } from "react";
import { PoolProfileFields, type FieldErrorText } from "@/components/pool/pool-profile-fields";
import { PoolPageShell } from "@/components/pool/pool-page-shell";
import { useBrowserLang } from "@/lib/i18n/browser-lang";
import type { Lang } from "@/lib/i18n/lang";
import type { PoolErrorKey } from "@/lib/i18n/pool-play";
import { defaultPoolForm, toPoolPayload, type PoolFormValue } from "@/lib/pool/form-state";
import { fieldErrorKeys, poolPageCopy } from "@/lib/pool/page-copy";
import { validatePoolSignup, type PoolFieldErrors } from "@/lib/pool/profile-fields";
import { PolicyLink } from "@/components/policy-link";
import { clearSignupDraft, loadSignupDraft, saveSignupDraft } from "@/lib/pool/signup-draft";
import { sendPoolSignup, type PoolSignupConfirm } from "@/lib/pool/send-signup";
import {
  checkPendingSignup,
  clearPendingSignup,
  loadPendingSignup,
  pendingSignupExpired,
  savePendingSignup,
  type PendingSignup,
} from "@/lib/pool/pending-signup";
import { PoolPendingReminder } from "@/components/pool/pool-pending-reminder";
import { PoolWhatsAppStep } from "@/components/pool/pool-whatsapp-step";
import { dayCommaTimeLabel } from "@/lib/i18n/dates";
import { friendLinkCopy } from "@/lib/i18n/friend-link";
import type { PoolFee } from "@/lib/pool/offer-copy";

type Confirm = PoolSignupConfirm;

/** A friend link's game (2026-10-31, `/play/f/<token>`). */
export interface FriendLinkCard {
  token: string;
  /** The member's first name. */
  member: string;
  club: string;
  kickoffIso: string;
  venue: string | null;
  address: string | null;
  fee: PoolFee;
  monthly: boolean;
  /** The name the member gave, for the form; null for "+1". */
  friendName: string | null;
}

export function PlaySignup({
  source,
  paused,
  invitedBy = null,
  earlyList,
  friend = null,
}: {
  source: { campaignCode: string | null; referralCode: string | null };
  paused: boolean;
  /** Will a sign-up made now go on the early sign-up list? The server's
   *  switch (`signupGoesOnEarlyListForPage`), so the note says so only then. */
  earlyList: boolean;
  /** Slice G1: the friend whose link this is, when his privacy switch shows his name. */
  invitedBy?: string | null;
  /** A friend link (2026-10-31): the game shown at the top, his name filled in. */
  friend?: FriendLinkCard | null;
}) {
  const browserLang = useBrowserLang();
  const [chosen, setChosen] = useState<Lang | null>(null);
  const lang = chosen ?? browserLang;
  const copy = poolPageCopy(lang);

  // The form's language follows the page's until he picks one himself.
  const [form, setForm] = useState<PoolFormValue | null>(null);
  const value = form ?? { ...defaultPoolForm(lang), name: friend?.friendName ?? "" };
  const [adult, setAdult] = useState(false);
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<PoolFieldErrors>({});
  const [formError, setFormError] = useState<PoolErrorKey | null>(null);
  const [sending, setSending] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [pending, setPending] = useState<PendingSignup | null>(null);
  const [expiredNote, setExpiredNote] = useState(false);

  // The reminder: once, on mount. Nothing shows until the server says the
  // sign-up still waits; a check that fails (busy, offline) shows nothing
  // and keeps the entry for next time.
  useEffect(() => {
    const stored = loadPendingSignup();
    if (!stored) return;
    if (pendingSignupExpired(stored, Date.now())) {
      clearPendingSignup();
      setExpiredNote(true);
      return;
    }
    let live = true;
    void checkPendingSignup(stored).then((state) => {
      if (!live) return;
      if (state === "waiting") setPending(stored);
      else if (state === "done") clearPendingSignup();
      else if (state === "gone") {
        clearPendingSignup();
        setExpiredNote(true);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  // A page left open past the code's end drops the reminder and its link.
  useEffect(() => {
    if (!pending) return;
    const wait = Math.min(Math.max(pending.expiresAt - Date.now(), 0), 2 ** 31 - 1);
    const timer = window.setTimeout(() => {
      clearPendingSignup();
      setPending(null);
      setExpiredNote(true);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [pending]);

  // The draft: read once after mount (the server never sees it), saved on
  // every change he makes, cleared once the sign-up is sent.
  useEffect(() => {
    // A friend link starts from the member's words, never an older draft.
    if (friend) return;
    const draft = loadSignupDraft(defaultPoolForm(browserLang));
    if (draft) setForm((f) => f ?? draft);
    // Once, on mount: a later language change must not reload the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (form && !confirm) saveSignupDraft(form);
  }, [form, confirm]);

  const keys = fieldErrorKeys(errors);
  const fieldText: FieldErrorText = Object.fromEntries(
    (["name", "area", "maxMiles", "availability", "sports"] as const).filter((k) => keys[k]).map((k) => [k, copy.errors[keys[k]!]]),
  );
  const hasErrors = Object.keys(errors).length > 0 || formError !== null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      ...toPoolPayload(value),
      adult,
      consent,
      source: { c: source.campaignCode ?? undefined, ref: source.referralCode ?? undefined },
      ...(friend ? { friendToken: friend.token } : {}),
    };
    const local = validatePoolSignup(body);
    setFormError(null);
    if (!local.ok) {
      setErrors(local.errors);
      return;
    }
    setErrors({});
    setSending(true);
    try {
      const result = await sendPoolSignup(body);
      if (result.kind === "ok") {
        clearSignupDraft();
        const c = result.confirm;
        if (c.statusToken && c.expiresAt) savePendingSignup({ code: c.code, waLink: c.waLink, token: c.statusToken, expiresAt: c.expiresAt });
        setPending(null);
        setExpiredNote(false);
        setConfirm(c);
        window.scrollTo({ top: 0 });
        return;
      }
      if (result.kind === "fields") setErrors(result.errors);
      else setFormError(result.reason);
    } finally {
      setSending(false);
    }
  }

  if (confirm) {
    return (
      <PoolPageShell lang={lang} onLang={setChosen} copy={copy}>
        <h1 className="text-2xl font-bold text-slate-900">{copy.signup.confirmHeading}</h1>
        <div className="mt-3">
          <PoolWhatsAppStep copy={copy} step={confirm} earlyList={confirm.earlyList} />
        </div>
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
      {pending && <PoolPendingReminder copy={copy} lang={lang} pending={pending} />}
      {expiredNote && (
        <p role="status" data-testid="pool-expired-note" className="mb-6 rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-800">
          {copy.signup.expiredNote}
        </p>
      )}
      {friend && <FriendCard friend={friend} lang={lang} />}
      {invitedBy && (
        <p data-testid="pool-invited-by" className="mb-3 text-sm font-medium text-emerald-800">
          {poolShareCopy(lang).invitedBy(invitedBy)}
        </p>
      )}
      <h1 className="text-2xl font-bold text-slate-900">{copy.signup.heading}</h1>
      <ol className="mt-3 list-decimal space-y-0.5 pl-5 text-sm text-slate-700">
        {copy.signup.howItWorks.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
      {earlyList && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-1.5 text-sm text-amber-900">{copy.signup.earlyShort}</p>}

      {paused ? (
        <p role="status" className="mt-8 rounded-lg bg-slate-100 px-4 py-3 text-slate-800">
          {copy.signup.pausedNote}
        </p>
      ) : (
        <form onSubmit={submit} noValidate className="mt-6 space-y-8">
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
              <PolicyLink className="text-blue-700 underline">{copy.signup.consentPolicy}</PolicyLink>
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

function FriendCard({ friend, lang }: { friend: FriendLinkCard; lang: Lang }) {
  const c = friendLinkCopy(lang);
  const fee =
    friend.fee?.kind === "amount" ? (friend.monthly ? c.page_fee_payg({ amount: friend.fee.amount }) : c.page_fee({ amount: friend.fee.amount })) : friend.fee?.kind === "free" ? c.page_free : null;
  return (
    <section data-testid="friend-link-card" className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-slate-900">
      <p className="text-sm font-semibold text-emerald-800">{c.page_invited({ member: friend.member })}</p>
      <p className="mt-1 text-lg font-bold">{friend.club}</p>
      <p className="text-sm">{dayCommaTimeLabel(lang, new Date(friend.kickoffIso))}</p>
      {friend.venue && <p className="text-sm">{friend.address ? `${friend.venue}, ${friend.address}` : friend.venue}</p>}
      {fee && <p className="text-sm">{fee}</p>}
      <p className="mt-3 text-sm text-slate-700">{c.page_explain}</p>
    </section>
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
