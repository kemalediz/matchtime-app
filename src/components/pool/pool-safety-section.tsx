"use client";

/**
 * His manage page, slice L7: why a pause MatchTime decided is on, with "Ask
 * a person to look at this" (the privacy policy's promise); his own
 * turn-up record (counts only); and the clubs that offered him games, each
 * with "Stop this club's offers" (the club is not told) and "Report a
 * problem" (the MatchTime team only). Every action is his own, signed in.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { poolSafetyCopy } from "@/lib/i18n/pool-safety";
import { formatPolicyDate } from "@/lib/i18n/privacy-policy-shared";
import type { Lang } from "@/lib/i18n/lang";
import type { PoolManageView } from "@/lib/pool/manage";
import { reportClubAction, requestPauseReviewAction, setOwnClubBlockAction } from "@/app/actions/pool-safety";
import { ReportForm } from "./report-form";

const BTN = "inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-semibold border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-60";

/** The line under his status for a pause MatchTime decided, and the review button. */
export function PoolPauseNote({ view, lang }: { view: PoolManageView; lang: Lang }) {
  const c = poolSafetyCopy(lang);
  const router = useRouter();
  const [asked, setAsked] = useState(view.reviewRequested);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();
  const reason = view.pausedReason;
  if (view.status !== "paused" || (reason !== "no-shows" && reason !== "reports" && reason !== "admin")) return null;
  const ready = view.canResume;
  const text =
    reason === "no-shows"
      ? ready
        ? c.paused_no_shows_ready
        : c.paused_no_shows({ from: formatPolicyDate(view.resumeFrom!.slice(0, 10), lang) })
      : reason === "reports"
        ? c.paused_reports
        : c.paused_admin;
  const ask = () =>
    start(async () => {
      setFailed(false);
      const r = await requestPauseReviewAction();
      if (r.ok || r.reason === "asked-already") {
        setAsked(true);
        router.refresh();
      } else setFailed(true);
    });
  return (
    <div className="mt-3 space-y-2" data-testid="pool-pause-note" data-reason={reason}>
      <p className="text-sm text-slate-700">{text}</p>
      {!ready &&
        (asked ? (
          <p role="status" className="text-sm text-emerald-800" data-testid="pool-review-asked">
            {c.review_asked}
          </p>
        ) : (
          <button type="button" data-testid="pool-review-ask" disabled={pending} onClick={ask} className={BTN}>
            {c.review_ask}
          </button>
        ))}
      {failed && (
        <p role="alert" className="text-sm text-red-700">
          {c.failed}
        </p>
      )}
    </div>
  );
}

function ClubRow({ club, lang }: { club: PoolManageView["clubs"][number]; lang: Lang }) {
  const c = poolSafetyCopy(lang);
  const [blocked, setBlocked] = useState(club.blocked);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();
  const toggle = () =>
    start(async () => {
      setFailed(false);
      const r = await setOwnClubBlockAction(club.orgId, !blocked);
      if (r.ok) setBlocked(!blocked);
      else setFailed(true);
    });
  return (
    <li className="rounded-xl border border-slate-200 p-4 space-y-3" data-testid="pool-club-row" data-blocked={blocked ? "yes" : "no"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-slate-900">{club.name}</span>
        {blocked && <span className="text-sm text-slate-600">{c.club_blocked}</span>}
      </div>
      <button type="button" data-testid="pool-club-block" disabled={pending} onClick={toggle} className={BTN}>
        {blocked ? c.club_unblock : c.club_block}
      </button>
      {failed && (
        <p role="alert" className="text-sm text-red-700">
          {c.failed}
        </p>
      )}
      <ReportForm lang={lang} side="player" testId="pool-club-report" send={(text) => reportClubAction(club.orgId, text)} />
    </li>
  );
}

/** His record and the clubs that offered him games. */
export function PoolRecordAndClubs({ view, lang }: { view: PoolManageView; lang: Lang }) {
  const c = poolSafetyCopy(lang);
  const games = view.record.played + view.record.missed;
  return (
    <>
      <section aria-labelledby="pool-record" className="mt-10 border-t border-slate-200 pt-8">
        <h2 id="pool-record" className="text-lg font-semibold text-slate-900">
          {c.record_heading}
        </h2>
        <p className="mt-2 text-slate-800" data-testid="pool-record">
          {games === 0 ? c.record_new : c.record_line({ played: view.record.played, games })}
        </p>
      </section>
      {view.clubs.length > 0 && (
        <section aria-labelledby="pool-clubs" className="mt-10 border-t border-slate-200 pt-8">
          <h2 id="pool-clubs" className="text-lg font-semibold text-slate-900">
            {c.clubs_heading}
          </h2>
          <p className="mt-1 text-sm text-slate-600">{c.clubs_hint}</p>
          <ul className="mt-4 space-y-3">
            {view.clubs.map((club) => (
              <ClubRow key={club.orgId} club={club} lang={lang} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
