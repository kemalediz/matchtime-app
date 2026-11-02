"use client";

/**
 * The partner pool invite's page (2026-11-02), every state of it:
 *
 *   join      who he joins as (his name, the last 4 digits of his number),
 *             the /play fields filled in from his club (`member-prefill.ts`),
 *             the two ticks unticked, one Join button; active at once
 *   done      after Join (one `pool_signup` event, source "partner-invite")
 *   member    already in the pool: nothing to do
 *   stopped   the consent tick and Start again: back on, details kept
 *   paused    pool sign-ups braked: the /play note
 *   expired,  one line and the plain /play sign-up
 *   invalid
 *
 * The same fields component, form model and validator as /play and the
 * profile's "Play elsewhere too". Words: `pool-partner-invite.*.ts` for
 * what is new here, `pool-play.*.ts` for the rest. It opens in his club's
 * language, with the switch.
 */
import Link from "next/link";
import { useState, useTransition } from "react";
import { PoolProfileFields, type FieldErrorText } from "@/components/pool/pool-profile-fields";
import { PoolPageShell } from "@/components/pool/pool-page-shell";
import { PoolTick } from "@/components/pool/pool-tick";
import { PolicyLink } from "@/components/policy-link";
import type { Lang } from "@/lib/i18n/lang";
import type { PoolErrorKey } from "@/lib/i18n/pool-play";
import { partnerInviteCopy } from "@/lib/i18n/pool-partner-invite";
import { fromSavedProfile, toPoolPayload, type PoolFormValue } from "@/lib/pool/form-state";
import { fieldErrorKeys, poolPageCopy } from "@/lib/pool/page-copy";
import type { PartnerInviteView } from "@/lib/pool/partner-invite";
import { POOL_PLAY_PATH } from "@/lib/pool/paths";
import { validatePoolSignup, type PoolFieldErrors } from "@/lib/pool/profile-fields";
import { countPoolSignup } from "@/lib/pool/send-signup";
import { joinPartnerInviteAction, restartPartnerInviteAction } from "../actions";

const BTN = "inline-flex items-center justify-center rounded-xl px-5 py-2.5 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-60";
const KNOWN_FAILURES: readonly PoolErrorKey[] = ["busy", "area-not-found", "paused", "link-closed"];

type Shown = PartnerInviteView["state"] | "done" | "restarted";

export function PartnerInvitePage({ token, view }: { token: string; view: PartnerInviteView }) {
  const [lang, setLang] = useState<Lang>(view.lang);
  const copy = poolPageCopy(lang);
  const c = partnerInviteCopy(lang);
  const [shown, setShown] = useState<Shown>(view.state);
  const [form, setForm] = useState<PoolFormValue | null>(null);
  const [adult, setAdult] = useState(false);
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<PoolFieldErrors>({});
  const [failure, setFailure] = useState<PoolErrorKey | null>(null);
  const [pending, start] = useTransition();

  const keys = fieldErrorKeys(errors);
  const fieldText: FieldErrorText = Object.fromEntries(
    (["name", "area", "maxMiles", "availability", "sports"] as const).filter((k) => keys[k]).map((k) => [k, copy.errors[keys[k]!]]),
  );
  const value = form ?? (view.prefill ? fromSavedProfile(view.prefill) : null);

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value) return;
    const body = { ...toPoolPayload(value), adult, consent };
    const local = validatePoolSignup(body);
    setFailure(null);
    if (!local.ok) {
      setErrors(local.errors);
      return;
    }
    setErrors({});
    start(async () => {
      const r = await joinPartnerInviteAction(token, body);
      if (r.ok) {
        countPoolSignup("partner-invite");
        setShown("done");
        window.scrollTo({ top: 0 });
        return;
      }
      if (r.reason === "already-in-pool") return setShown("member");
      if (r.errors) setErrors(r.errors);
      else setFailure(KNOWN_FAILURES.find((k) => k === r.reason) ?? "generic");
    });
  };

  const restart = (e: React.FormEvent) => {
    e.preventDefault();
    setFailure(null);
    if (!consent) {
      setErrors({ consent: "required" });
      return;
    }
    setErrors({});
    start(async () => {
      const r = await restartPartnerInviteAction(token, true);
      if (r.ok) return setShown("restarted");
      // Started again meanwhile (another tab): he is in.
      if (r.reason === "not-stopped") return setShown("member");
      setFailure(KNOWN_FAILURES.find((k) => k === r.reason) ?? "generic");
    });
  };

  const alert = (failure || Object.keys(errors).length > 0) && (
    <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800">
      {failure ? copy.errors[failure] : copy.errorSummary}
    </p>
  );
  const message = (heading: string, body: string, withSignup = false) => (
    <>
      <h1 className="text-2xl font-bold text-slate-900">{heading}</h1>
      <p className="mt-3 text-slate-700">{body}</p>
      {withSignup && (
        <Link href={POOL_PLAY_PATH} className={`${BTN} mt-5 bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500`}>
          {c.signup_link}
        </Link>
      )}
    </>
  );

  let body: React.ReactNode;
  switch (shown) {
    case "invalid":
      body = message(c.invalid_heading, c.invalid_body, true);
      break;
    case "expired":
      body = message(c.expired_heading, c.expired_body, true);
      break;
    case "member":
      body = message(c.member_heading, c.member_body);
      break;
    case "done":
      body = (
        <>
          {message(c.done_heading, c.done_body)}
          {view.earlyList && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{copy.manage.earlyNote}</p>}
        </>
      );
      break;
    case "restarted":
      body = message(c.restarted_heading, copy.manage.status.active);
      break;
    case "paused":
      body = message(copy.signup.heading, copy.signup.pausedNote);
      break;
    case "stopped":
      body = (
        <form onSubmit={restart} noValidate className="space-y-6">
          {message(c.stopped_heading, c.stopped_body)}
          {alert}
          <PoolTick checked={consent} onChange={setConsent} label={copy.manage.restartConsent} error={keys.consent ? copy.errors.consent : undefined} />
          <button type="submit" disabled={pending} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500`}>
            {pending ? copy.member.joining : copy.manage.restart}
          </button>
        </form>
      );
      break;
    case "join":
      body = (
        <>
          <h1 className="text-2xl font-bold text-slate-900">{copy.signup.heading}</h1>
          <p className="mt-3 text-slate-700">{c.page_lead}</p>
          <p className="mt-1 text-sm text-slate-500">{c.page_optional}</p>
          {view.tail && (
            <p data-testid="partner-invite-you" className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              {view.name ? c.page_you({ name: view.name, tail: view.tail }) : c.page_you_no_name({ tail: view.tail })}
            </p>
          )}
          {value && (
            <form onSubmit={join} noValidate className="mt-6 space-y-8">
              <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900">{copy.member.prefillNote}</p>
              {view.earlyList && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{copy.signup.earlyNote}</p>}
              {alert}
              <PoolProfileFields value={value} onChange={setForm} copy={copy.fields} lang={lang} errors={fieldText} />
              <div className="space-y-4 border-t border-slate-200 pt-6">
                <PoolTick checked={adult} onChange={setAdult} label={copy.signup.adultLabel} error={keys.adult ? copy.errors.adult : undefined} />
                <PoolTick checked={consent} onChange={setConsent} label={copy.signup.consentLabel} error={keys.consent ? copy.errors.consent : undefined} />
                <p className="text-sm">
                  <PolicyLink className="text-blue-700 underline">{copy.signup.consentPolicy}</PolicyLink>
                </p>
              </div>
              <button type="submit" disabled={pending} className={`${BTN} w-full bg-blue-600 py-3 text-base text-white hover:bg-blue-700 focus:ring-blue-500 sm:w-auto`}>
                {pending ? copy.member.joining : copy.member.join}
              </button>
            </form>
          )}
        </>
      );
      break;
  }

  return (
    <PoolPageShell lang={lang} onLang={setLang} copy={copy}>
      <div data-testid="partner-invite" data-state={shown}>
        {body}
      </div>
    </PoolPageShell>
  );
}
