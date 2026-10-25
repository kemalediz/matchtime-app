"use client";

/**
 * The manage page's view (slice L2): status and its switches, the same
 * fields as the sign-up (PoolProfileFields), the badge privacy switch, and
 * delete with a second tap to confirm. Opens in the profile's language,
 * with the switch. No wording here (page-copy.ts).
 */
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { PoolProfileFields, type FieldErrorText } from "@/components/pool/pool-profile-fields";
import { PoolPageShell } from "@/components/pool/pool-page-shell";
import { PoolShareCard } from "@/components/pool/pool-share-card";
import { PoolPauseNote, PoolRecordAndClubs } from "@/components/pool/pool-safety-section";
import { deletePoolProfileAction, poolManageAction, savePoolProfileAction, setPoolRecognitionAction } from "@/app/actions/pool-manage";
import type { Lang } from "@/lib/i18n/lang";
import type { PoolErrorKey } from "@/lib/i18n/pool-play";
import { formatPolicyDate } from "@/lib/i18n/privacy-policy-shared";
import { inviteCopy } from "@/lib/i18n/pool-invite";
import { fromSavedProfile, toPoolPayload, type PoolFormValue } from "@/lib/pool/form-state";
import type { PoolManageView } from "@/lib/pool/manage";
import type { ManageAction } from "@/lib/pool/manage-rules";
import { fieldErrorKeys, poolPageCopy } from "@/lib/pool/page-copy";
import { validatePoolFields, type PoolFieldErrors } from "@/lib/pool/profile-fields";
import { sportChoiceKey } from "@/lib/pool/sports";
import { POOL_INVITATIONS_PATH, POOL_PLAY_PATH } from "@/lib/pool/paths";

const BTN = "inline-flex items-center justify-center rounded-xl px-5 py-2.5 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-60";

export function ManageView({ view }: { view: PoolManageView | null }) {
  const router = useRouter();
  const [lang, setLang] = useState<Lang>(view?.fields.language ?? "en");
  const copy = poolPageCopy(lang);
  const m = copy.manage;
  const [form, setForm] = useState<PoolFormValue | null>(view ? fromSavedProfile(view.fields) : null);
  const [errors, setErrors] = useState<PoolFieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<PoolErrorKey | null>(null);
  const [restartConsent, setRestartConsent] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleted, setDeleted] = useState(false);
  // The switch moves at once; the server's answer puts it back if it failed.
  const [showRecognition, setShowRecognitionState] = useState(view?.showRecognition ?? true);
  const [pending, start] = useTransition();

  if (deleted || !view || !form) {
    return (
      <PoolPageShell lang={lang} onLang={setLang} copy={copy}>
        <h1 className="text-2xl font-bold text-slate-900">{deleted ? m.deletedHeading : m.heading}</h1>
        <p className="mt-3 text-slate-700" role={deleted ? "status" : undefined}>
          {deleted ? m.deletedBody : m.noProfile}
        </p>
        <Link href={POOL_PLAY_PATH} className="mt-6 inline-block font-semibold text-blue-700 underline">
          {m.signUpLink}
        </Link>
      </PoolPageShell>
    );
  }

  const keys = fieldErrorKeys(errors);
  const fieldText: FieldErrorText = Object.fromEntries(
    (["name", "area", "maxMiles", "availability", "sports"] as const).filter((k) => keys[k]).map((k) => [k, copy.errors[keys[k]!]]),
  );
  const pausedByMatchTime = view.status === "paused" && view.pausedReason !== "self" && view.pausedReason !== "ignored";
  // Slice L7: a no-show pause is his to lift 30 days after it began.
  const canResume = view.canResume;
  const statusText =
    view.status === "active" ? m.status.active : view.status === "stopped" ? m.status.stopped : pausedByMatchTime ? m.status.pausedByMatchTime : m.status.paused;

  const act = (action: ManageAction) =>
    start(async () => {
      setNotice(null);
      const r = await poolManageAction(action, action === "restart" ? restartConsent : undefined);
      setFailure(r.ok ? null : r.reason === "consent-required" ? "consent" : "generic");
      router.refresh();
    });

  const save = () =>
    start(async () => {
      setNotice(null);
      setFailure(null);
      const payload = toPoolPayload(form);
      const local = validatePoolFields(payload, { keep: view.fields.sports.map(sportChoiceKey) });
      if (!local.ok) {
        setErrors(local.errors);
        return;
      }
      setErrors({});
      const r = await savePoolProfileAction(payload);
      if (r.ok) {
        setNotice(m.saved);
        router.refresh();
      } else if (r.errors) setErrors(r.errors);
      else setFailure(r.reason === "area-not-found" ? r.reason : "generic");
    });

  const remove = () =>
    start(async () => {
      const r = await deletePoolProfileAction();
      if (!r.ok) {
        setFailure("generic");
        return;
      }
      setDeleted(true);
      if (r.userErased) await signOut({ redirect: false });
    });

  return (
    <PoolPageShell lang={lang} onLang={setLang} copy={copy}>
      <h1 className="text-2xl font-bold text-slate-900">{m.heading}</h1>
      {/* My invitations (pool L8): his club invitations and open game offers. */}
      <p className="mt-2 text-sm">
        <Link href={POOL_INVITATIONS_PATH} data-testid="pool-manage-invitations" className="font-semibold text-blue-700 underline">
          {inviteCopy(lang).inv_title}
        </Link>
      </p>

      {(failure || Object.keys(errors).length > 0) && (
        <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800">
          {failure ? copy.errors[failure] : copy.errorSummary}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-4 rounded-lg bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900">
          {notice}
        </p>
      )}

      <section aria-labelledby="pool-status" className="mt-6">
        <h2 id="pool-status" className="text-lg font-semibold text-slate-900">
          {m.statusLabel}
        </h2>
        <p className="mt-2 text-slate-800" data-testid="pool-status">
          {statusText}
        </p>
        <PoolPauseNote view={view} lang={lang} />
        {view.earlyList && <p className="mt-2 text-sm text-slate-600">{m.earlyNote}</p>}
        {view.consentAt && view.consentVersion !== null && (
          <p className="mt-2 text-sm text-slate-600">{m.consentLine(formatPolicyDate(view.consentAt.slice(0, 10), lang), view.consentVersion)}</p>
        )}
        <div className="mt-4 flex flex-wrap gap-3">
          {view.status === "active" && (
            <button type="button" disabled={pending} onClick={() => act("pause")} className={`${BTN} bg-slate-800 text-white hover:bg-slate-900 focus:ring-slate-500`}>
              {m.pause}
            </button>
          )}
          {canResume && (
            <button type="button" disabled={pending} onClick={() => act("resume")} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500`}>
              {m.resume}
            </button>
          )}
          {(view.status === "active" || view.status === "paused") && (
            <button type="button" disabled={pending} onClick={() => act("stop")} className={`${BTN} border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 focus:ring-slate-400`}>
              {m.stop}
            </button>
          )}
        </div>
        {(view.status === "active" || view.status === "paused") && <p className="mt-2 text-sm text-slate-600">{m.stopHint}</p>}
        {view.status === "stopped" && (
          <div className="mt-4 space-y-3">
            <label className="flex items-start gap-3 text-sm text-slate-900">
              <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={restartConsent} onChange={(e) => setRestartConsent(e.target.checked)} />
              <span>{m.restartConsent}</span>
            </label>
            <button type="button" disabled={pending} onClick={() => act("restart")} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500`}>
              {m.restart}
            </button>
          </div>
        )}
      </section>

      <section aria-labelledby="pool-edit" className="mt-10 border-t border-slate-200 pt-8">
        <h2 id="pool-edit" className="mb-6 text-lg font-semibold text-slate-900">
          {m.editHeading}
        </h2>
        <PoolProfileFields value={form} onChange={setForm} copy={copy.fields} lang={lang} errors={fieldText} />
        <button type="button" disabled={pending} onClick={save} className={`${BTN} mt-8 bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500`}>
          {pending ? m.saving : m.save}
        </button>
      </section>

      <section aria-labelledby="pool-privacy" className="mt-10 border-t border-slate-200 pt-8">
        <h2 id="pool-privacy" className="text-lg font-semibold text-slate-900">
          {m.privacyHeading}
        </h2>
        <label className="mt-3 flex items-start gap-3 text-sm text-slate-900">
          <input
            type="checkbox"
            role="switch"
            className="mt-0.5 h-5 w-5 shrink-0"
            checked={showRecognition}
            onChange={(e) => {
              const next = e.target.checked;
              setShowRecognitionState(next);
              start(async () => {
                const r = await setPoolRecognitionAction(next);
                if (!r.ok) {
                  setShowRecognitionState(!next);
                  setFailure("generic");
                }
              });
            }}
          />
          <span>{m.showRecognitionLabel}</span>
        </label>
        <p className="mt-1 pl-8 text-sm text-slate-600">{m.showRecognitionHint}</p>
      </section>

      {/* Slice L7: his turn-up record, and the clubs that offered him games. */}
      <PoolRecordAndClubs view={view} lang={lang} />

      {/* Slice G1: his share link; reloads when the privacy switch or his status moves. */}
      <PoolShareCard lang={lang} refreshKey={`${showRecognition}:${view.status}`} />

      <section aria-labelledby="pool-delete" className="mt-10 border-t border-slate-200 pt-8">
        <h2 id="pool-delete" className="text-lg font-semibold text-slate-900">
          {m.deleteHeading}
        </h2>
        <p className="mt-2 text-sm text-slate-700">{m.deleteHint}</p>
        {confirmDelete ? (
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" disabled={pending} onClick={remove} className={`${BTN} bg-red-600 text-white hover:bg-red-700 focus:ring-red-500`}>
              {m.deleteConfirm}
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} className={`${BTN} border border-slate-300 bg-white text-slate-800 focus:ring-slate-400`}>
              {m.deleteCancel}
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmDelete(true)} className={`${BTN} mt-4 border border-red-300 bg-white text-red-700 hover:bg-red-50 focus:ring-red-400`}>
            {m.deleteButton}
          </button>
        )}
      </section>
    </PoolPageShell>
  );
}
