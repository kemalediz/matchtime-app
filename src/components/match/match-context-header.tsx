/**
 * Which match a page is about (Kemal, 2026-10-18).
 *
 * The payments page and the team management page are opened from a
 * match, and used to show only the game's name: no day, no kickoff, no
 * venue, so an organiser lost track of which match they were on. This
 * header names it the way the match page does (game, format, day and
 * kickoff in the club's language, venue, status, the score once there is
 * one) and links back to it.
 *
 * Presentational only: no data fetching, no hooks, so the server
 * payments page and the client teams page both render it. It shows
 * nothing either page did not already have the right to read.
 */
import Link from "next/link";
import { ArrowLeft, Calendar, Clock, MapPin } from "lucide-react";
import { matchContext } from "@/lib/match-context";
import type { Lang } from "@/lib/i18n/lang";

export type MatchContextHeaderProps = {
  matchId: string;
  /** The game's name, e.g. "Tuesday 7-a-side". */
  title: string;
  /** The format, e.g. "Football 5-a-side". */
  sportName: string | null | undefined;
  /** The club, shown small above the title when given. */
  clubName?: string | null;
  venue: string | null | undefined;
  date: Date | string;
  status: string;
  redScore: number | null;
  yellowScore: number | null;
  teamLabels: [string, string];
  lang: Lang | string | null | undefined;
  /** 1 when the match IS the page's heading (payments); 2 under a page
   *  that has its own (team management). */
  headingLevel?: 1 | 2;
};

export function MatchContextHeader(p: MatchContextHeaderProps) {
  const c = matchContext(p);
  const Heading = p.headingLevel === 2 ? "h2" : "h1";
  return (
    <header data-testid="match-context-header" className="w-full min-w-0 space-y-2">
      <Link
        href={`/matches/${p.matchId}`}
        data-testid="match-context-back"
        className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700"
      >
        <ArrowLeft className="w-4 h-4" />
        {c.backLabel}
      </Link>
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm px-4 py-3 space-y-2 min-w-0">
        {p.clubName && (
          <p className="text-xs uppercase tracking-wider text-slate-400 break-words">{p.clubName}</p>
        )}
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Heading data-testid="match-context-title" className="text-lg font-bold text-slate-900 break-words min-w-0">
            {p.title}
          </Heading>
          <span
            data-testid="match-context-status"
            className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium ${c.statusTone}`}
          >
            {c.statusLabel}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
          {p.sportName && (
            <span data-testid="match-context-sport" className="inline-flex px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 text-xs font-medium">
              {p.sportName}
            </span>
          )}
          <span data-testid="match-context-date" className="inline-flex items-center gap-1.5">
            <Calendar className="w-4 h-4 shrink-0 text-slate-400" />
            {c.dateLabel}
          </span>
          <span data-testid="match-context-time" className="inline-flex items-center gap-1.5">
            <Clock className="w-4 h-4 shrink-0 text-slate-400" />
            {c.kickoffLabel}
          </span>
          {p.venue && (
            <span data-testid="match-context-venue" className="inline-flex items-center gap-1.5 min-w-0 break-words">
              <MapPin className="w-4 h-4 shrink-0 text-slate-400" />
              {p.venue}
            </span>
          )}
        </div>
        {c.score && (
          <p data-testid="match-context-score" className="text-sm font-semibold text-slate-800 break-words">
            {c.score.redLabel} <span className="tabular-nums text-red-500">{c.score.red}</span>
            <span className="text-slate-300"> - </span>
            <span className="tabular-nums text-amber-500">{c.score.yellow}</span> {c.score.yellowLabel}
          </p>
        )}
      </div>
    </header>
  );
}
