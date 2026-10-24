/**
 * GUEST PLAYERS (local player pool, slice L5b, 2026-10-24). The club's
 * guests: players from partner clubs and from the MatchTime player pool.
 * Three tabs (approved spec, "Guest players in the app"):
 *   Upcoming  accepted guests grouped by match;
 *   History   every past guest, each game here and whether he joined;
 *   Report    by month or season, filtered by sport and venue, CSV.
 * Owners and admins of the club only (the admin layout checks too). The
 * facts are `loadGuestFacts`, every decision the pure `guest-report.ts`.
 */
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getUserOrg, isOrgAdmin } from "@/lib/org";
import { t } from "@/lib/i18n/t";
import { normaliseLang } from "@/lib/i18n/lang";
import { loadGuestFacts } from "@/lib/pool/guest-report-loader";
import { buildGuestPlayers, buildGuestReport, parseGuestPageQuery, reportFilterOptions } from "@/lib/pool/guest-report";
import { GuestTabs } from "./guest-tabs";
import { HistoryList, UpcomingList } from "./guest-lists";
import { GuestReportView } from "./guest-report-view";

export const dynamic = "force-dynamic";

export default async function GuestPlayersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const membership = await getUserOrg(session.user.id);
  if (!membership || !(await isOrgAdmin(session.user.id, membership.orgId))) redirect("/");

  const query = parseGuestPageQuery(await searchParams);
  const orgId = membership.orgId;
  const lang = normaliseLang(membership.org.language);
  const s = t(lang);
  const now = new Date();
  const facts = await loadGuestFacts(orgId, { report: query.tab === "report" });
  const players = buildGuestPlayers({ orgId, now, lang, games: facts.games, people: facts.people });
  const list = { s, lang, orgId, cards: players.cards, poolClub: membership.org.featurePlayerPool === true };

  return (
    <div className="space-y-5" data-testid="guest-players-page">
      <div>
        <h2 className="text-lg font-semibold text-slate-800">{s.gst_title}</h2>
        <p className="text-sm text-slate-500 mt-1">{s.gst_intro}</p>
      </div>
      <GuestTabs s={s} current={query.tab} />
      {query.tab === "upcoming" && <UpcomingList {...list} groups={players.upcoming} />}
      {query.tab === "history" && <HistoryList {...list} rows={players.history} />}
      {query.tab === "report" && (
        <GuestReportView
          s={s}
          lang={lang}
          query={query}
          report={buildGuestReport({ orgId, now, games: facts.games, asks: facts.asks, matches: facts.matches, members: facts.members }, query)}
          options={reportFilterOptions(facts.matches)}
        />
      )}
    </div>
  );
}
