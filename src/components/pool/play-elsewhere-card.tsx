"use client";

/**
 * "PLAY ELSEWHERE TOO" on a club member's own profile (local player pool,
 * slice L3; plan 3.2). The member joins the pool without the stranger flow:
 *
 *   in the pool already   his status and the link to /play/manage
 *   a number on account   the /play fields, filled in from his clubs
 *                         (`member-prefill.ts`), the two ticks unticked,
 *                         the policy link; joining makes him active at once
 *   no number             the same form, then the /play WhatsApp step,
 *                         whose own message verifies his number onto his
 *                         account
 *
 * The same fields component, form model and validator as /play and the
 * manage page; no wording here (`copy.member`, `copy.signup`).
 *
 * The pool banner's "Join the pool" (2026-10-28) links here as
 * `/profile#play-elsewhere` (or, already on /profile, fires
 * `PLAY_ELSEWHERE_FOCUS_EVENT`): once loaded, the card scrolls itself into
 * view, lights up for a few seconds and puts the focus on its first step.
 */
import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Globe2 } from "lucide-react";
import { answerPlayElsewhereClaim, joinPlayElsewhereAction, loadPlayElsewhereAction, startPlayElsewhereWhatsApp, type PlayElsewhereState, type WhatsAppStep } from "@/app/actions/pool-member";
import { PoolProfileFields, type FieldErrorText } from "@/components/pool/pool-profile-fields";
import { PoolShareCard } from "@/components/pool/pool-share-card";
import { PoolTick } from "@/components/pool/pool-tick";
import { PoolWhatsAppStep } from "@/components/pool/pool-whatsapp-step";
import type { Lang } from "@/lib/i18n/lang";
import type { PoolErrorKey } from "@/lib/i18n/pool-play";
import { fromSavedProfile, toPoolPayload, type PoolFormValue } from "@/lib/pool/form-state";
import { fieldErrorKeys, poolPageCopy } from "@/lib/pool/page-copy";
import { PLAY_ELSEWHERE_ANCHOR, PLAY_ELSEWHERE_FOCUS_EVENT, POOL_MANAGE_PATH } from "@/lib/pool/paths";
import { validatePoolSignup, type PoolFieldErrors } from "@/lib/pool/profile-fields";
import { PolicyLink } from "@/components/policy-link";

const BTN = "inline-flex items-center justify-center rounded-xl px-5 py-2.5 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-60";
const KNOWN_FAILURES: readonly PoolErrorKey[] = ["busy", "area-not-found", "paused", "unavailable"];

const HIGHLIGHT_MS = 4000;

export function PlayElsewhereCard({ lang }: { lang: Lang }) {
  const copy = poolPageCopy(lang);
  const m = copy.member;
  const [state, setState] = useState<PlayElsewhereState | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PoolFormValue | null>(null);
  const [adult, setAdult] = useState(false);
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<PoolFieldErrors>({});
  const [failure, setFailure] = useState<PoolErrorKey | null>(null);
  const [step, setStep] = useState<WhatsAppStep | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [highlight, setHighlight] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  const reload = () => loadPlayElsewhereAction().then((s) => {
    setState(s);
    if (s.ok) setStep(s.whatsApp);
  });
  useEffect(() => {
    void reload();
  }, []);

  // Arriving from the pool banner: scroll here, light up, focus the first step.
  const loaded = !!state?.ok;
  useEffect(() => {
    if (!loaded) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const focusCard = () => {
      const el = sectionRef.current;
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.querySelector<HTMLElement>("[data-play-elsewhere-first]")?.focus({ preventScroll: true });
      setHighlight(true);
      clearTimeout(timer);
      timer = setTimeout(() => setHighlight(false), HIGHLIGHT_MS);
    };
    if (window.location.hash === `#${PLAY_ELSEWHERE_ANCHOR}`) focusCard();
    const onHash = () => window.location.hash === `#${PLAY_ELSEWHERE_ANCHOR}` && focusCard();
    window.addEventListener("hashchange", onHash);
    window.addEventListener(PLAY_ELSEWHERE_FOCUS_EVENT, focusCard);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener(PLAY_ELSEWHERE_FOCUS_EVENT, focusCard);
    };
  }, [loaded]);

  if (!state || !state.ok) return null;
  const { view, paused } = state;
  const path = view.path;

  const keys = fieldErrorKeys(errors);
  const fieldText: FieldErrorText = Object.fromEntries(
    (["name", "area", "maxMiles", "availability", "sports"] as const).filter((k) => keys[k]).map((k) => [k, copy.errors[keys[k]!]]),
  );
  const value = form ?? fromSavedProfile(view.prefill);
  const viaWhatsApp = path.kind === "join-whatsapp" || path.kind === "waiting-whatsapp";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body = { ...toPoolPayload(value), adult, consent };
    const local = validatePoolSignup(body);
    setFailure(null);
    if (!local.ok) {
      setErrors(local.errors);
      return;
    }
    setErrors({});
    start(async () => {
      const r = viaWhatsApp ? await startPlayElsewhereWhatsApp(body) : await joinPlayElsewhereAction(body);
      if (r.ok) {
        setOpen(false);
        await reload();
        return;
      }
      if (r.errors) setErrors(r.errors);
      else setFailure(KNOWN_FAILURES.find((k) => k === r.reason) ?? "generic");
    });
  };

  const answer = (yes: boolean) =>
    start(async () => {
      setFailure(null);
      setNotice(null);
      const r = await answerPlayElsewhereClaim(yes);
      if (r.ok) setNotice(r.answer === "no" ? m.claimNoDone : null);
      else setNotice(r.reason === "no-claim" ? m.claimExpired : m.claimTaken);
      await reload();
    });

  let body: React.ReactNode;
  if (path.kind === "claim") {
    body = (
      <div className="mt-4" data-testid="play-elsewhere-claim">
        <h3 className="text-base font-semibold text-slate-900">{m.claimHeading}</h3>
        <p className="mt-2 text-slate-800">{m.claimQuestion(path.tail)}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" disabled={pending} onClick={() => answer(true)} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500`}>
            {m.claimYes}
          </button>
          <button type="button" disabled={pending} onClick={() => answer(false)} className={`${BTN} border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 focus:ring-slate-400`}>
            {m.claimNo}
          </button>
        </div>
      </div>
    );
  } else if (path.kind === "in-pool") {
    body = (
      <>
        <p className="mt-3 font-medium text-slate-900">{m.inPool}</p>
        <p className="mt-1 text-sm text-slate-700" data-testid="play-elsewhere-status">
          {copy.manage.status[path.status]}
        </p>
        {view.earlyList && <p className="mt-1 text-sm text-slate-600">{copy.manage.earlyNote}</p>}
        <Link href={POOL_MANAGE_PATH} className="mt-3 inline-block font-semibold text-blue-700 underline">
          {m.manageLink}
        </Link>
        <PoolShareCard lang={lang} />
      </>
    );
  } else if (path.kind === "waiting-whatsapp" && step && !open) {
    body = (
      <div className="mt-4">
        <h3 className="text-base font-semibold text-slate-900">{m.waitingHeading}</h3>
        <div className="mt-2">
          <PoolWhatsAppStep copy={copy} step={step} earlyList={view.earlyList} />
        </div>
        <button type="button" onClick={() => setOpen(true)} className="mt-4 text-sm font-semibold text-blue-700 underline">
          {m.startAgain}
        </button>
      </div>
    );
  } else if (paused) {
    body = <p className="mt-3 text-sm text-slate-700">{copy.signup.pausedNote}</p>;
  } else if (!open) {
    body = (
      <button type="button" data-play-elsewhere-first onClick={() => setOpen(true)} className={`${BTN} mt-4 bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500`}>
        {m.open}
      </button>
    );
  } else {
    body = (
      <form onSubmit={submit} noValidate className="mt-6 space-y-8">
        <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900">{m.prefillNote}</p>
        {view.earlyList && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{copy.signup.earlyNote}</p>}
        {(failure || Object.keys(errors).length > 0) && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800">
            {failure ? copy.errors[failure] : copy.errorSummary}
          </p>
        )}
        <PoolProfileFields value={value} onChange={setForm} copy={copy.fields} lang={lang} errors={fieldText} />
        <div className="space-y-4 border-t border-slate-200 pt-6">
          <PoolTick checked={adult} onChange={setAdult} label={copy.signup.adultLabel} error={keys.adult ? copy.errors.adult : undefined} />
          <PoolTick checked={consent} onChange={setConsent} label={copy.signup.consentLabel} error={keys.consent ? copy.errors.consent : undefined} />
          <p className="text-sm">
            <PolicyLink className="text-blue-700 underline">{copy.signup.consentPolicy}</PolicyLink>
          </p>
        </div>
        {viaWhatsApp && <p className="text-sm text-slate-700">{m.whatsAppNote}</p>}
        <button type="submit" disabled={pending} className={`${BTN} w-full bg-blue-600 py-3 text-base text-white hover:bg-blue-700 focus:ring-blue-500 sm:w-auto`}>
          {pending ? m.joining : viaWhatsApp ? m.continueWhatsApp : m.join}
        </button>
      </form>
    );
  }

  return (
    <section
      ref={sectionRef}
      aria-labelledby={PLAY_ELSEWHERE_ANCHOR}
      data-highlight={highlight ? "on" : undefined}
      className={`scroll-mt-44 lg:scroll-mt-24 bg-white rounded-xl border shadow-sm p-6 transition-shadow duration-500 ${highlight ? "border-blue-400 ring-4 ring-blue-200" : "border-slate-200"}`}
      data-testid="play-elsewhere"
    >
      <h2 id={PLAY_ELSEWHERE_ANCHOR} className="flex items-center gap-2 text-lg font-semibold text-slate-800">
        <Globe2 className="h-5 w-5 text-blue-600" aria-hidden="true" />
        {m.heading}
      </h2>
      {path.kind !== "in-pool" && path.kind !== "claim" && (
        <>
          <p className="mt-2 text-sm text-slate-700">{m.lead}</p>
          <p className="mt-1 text-sm text-slate-500">{m.ownClubNote}</p>
        </>
      )}
      {notice && (
        <p role="status" className="mt-4 rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-800">
          {notice}
        </p>
      )}
      {body}
    </section>
  );
}
