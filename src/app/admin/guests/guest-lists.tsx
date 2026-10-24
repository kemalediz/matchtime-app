/**
 * Upcoming and History on the Guest players page (pool slice L5b). Server
 * components over the pure read model; each guest's name opens his card.
 */
import { GuestCardTrigger } from "@/components/guests/guest-card";
import { GuestSafety } from "@/components/guests/guest-safety";
import { poolSafetyCopy } from "@/lib/i18n/pool-safety";
import { guestSourceText, turnUpText } from "@/components/guests/guest-text";
import { dayLabel, historyDateLabel, timeLabel } from "@/lib/i18n/dates";
import type { Strings } from "@/lib/i18n/t";
import type { GuestCard, HistoryRow, UpcomingGroup } from "@/lib/pool/guest-report";
import { EmptyState } from "./guest-tabs";

interface ListProps {
  s: Strings;
  lang: string;
  orgId: string;
  cards: Record<string, GuestCard>;
}

/** Name (opens the card), where he came from, his turn-up record. */
function GuestLine({ s, lang, orgId, card, extra }: { s: Strings; lang: string; orgId: string; card: GuestCard; extra?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-3">
      <GuestCardTrigger card={card} lang={lang} orgId={orgId} extra={<GuestSafety orgId={orgId} userId={card.userId} blocked={card.blocked} lang={lang} />} />
      <span className="text-sm text-slate-600" data-testid="guest-source">
        {guestSourceText(s, card)}
      </span>
      <span className="text-sm text-slate-500" data-testid="guest-record">
        {turnUpText(s, card.record)}
      </span>
      {extra}
    </div>
  );
}

export function UpcomingList({ s, lang, orgId, cards, groups }: ListProps & { groups: UpcomingGroup[] }) {
  if (groups.length === 0) return <EmptyState testId="guest-empty-upcoming">{s.gst_empty_upcoming}</EmptyState>;
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <section key={g.matchId} data-testid="guest-upcoming-match" aria-labelledby={`gm-${g.matchId}`} className="bg-white rounded-xl border border-slate-200 shadow-sm">
          <h3 id={`gm-${g.matchId}`} className="px-4 sm:px-6 py-3 border-b border-slate-100 text-sm font-semibold text-slate-800">
            {dayLabel(lang, g.kickoff)}, {s.mch_kickoff({ time: timeLabel(g.kickoff) })}, {g.venue}
          </h3>
          <ul className="divide-y divide-slate-100">
            {g.guests.map((x) => (
              <li key={x.userId} data-testid="guest-upcoming-row" className="px-4 sm:px-6 py-3">
                <GuestLine
                  s={s}
                  lang={lang}
                  orgId={orgId}
                  card={cards[x.userId]}
                  extra={
                    x.onBench ? (
                      <span className="text-xs font-medium text-slate-600" data-testid="guest-on-bench">
                        {s.gst_on_bench}
                      </span>
                    ) : null
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const RESULT_TONE: Record<string, string> = {
  played: "bg-green-50 text-green-800",
  "no-show": "bg-red-50 text-red-800",
  "late-cancel": "bg-amber-50 text-amber-800",
  withdrawn: "bg-slate-100 text-slate-700",
  booked: "bg-blue-50 text-blue-800",
};

export function HistoryList({ s, lang, orgId, cards, rows }: ListProps & { rows: HistoryRow[] }) {
  if (rows.length === 0) return <EmptyState testId="guest-empty-history">{s.gst_empty_history}</EmptyState>;
  return (
    <ul className="space-y-4">
      {rows.map((r) => (
        <li key={r.userId} data-testid="guest-history-row" className="bg-white rounded-xl border border-slate-200 shadow-sm px-4 sm:px-6 py-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <GuestLine s={s} lang={lang} orgId={orgId} card={cards[r.userId]} />
            <span
              data-testid="guest-joined"
              data-joined={r.joined ? "yes" : "no"}
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.joined ? "bg-green-50 text-green-800" : "bg-slate-100 text-slate-600"}`}
            >
              {r.joined ? s.gst_joined : s.gst_not_joined}
            </span>
          </div>
          <ul className="space-y-1 text-sm">
            {r.games.map((g) => (
              <li key={g.matchId} data-testid="guest-history-game" data-result={g.result} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-slate-700">{historyDateLabel(lang, g.kickoff)}</span>
                <span className="text-slate-500">{g.venue}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${RESULT_TONE[g.result] ?? ""}`}>
                  {/* A past game still "booked" is waiting for its result (slice L7). */}
                  {g.result === "booked" ? poolSafetyCopy(lang).result_due : s.gst_result({ outcome: g.result })}
                </span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
