import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import Link from "next/link";
import { AttendButton } from "@/components/match/attend-button";
import { AttendanceList } from "@/components/match/attendance-list";
import { AddPlayerToMatch } from "@/components/match/add-player-to-match";
import { CarryOverSquadButton } from "@/components/match/carry-over-squad-button";
import { WaitingListControls } from "@/components/match/waiting-list-controls";
import { summariseClubDisplayRatings } from "@/lib/player-rating";
import { loadGuestStandings } from "@/lib/partner-guest-standing";
import { GUEST_MEMBER_WHERE, guestSourceOf, partnerHomeClubOf } from "@/lib/guest-membership";
import { standingPhrase } from "@/lib/partner-guest-standing-rules";
import { positionLabel } from "@/lib/organiser-pick-rules";
import { findCarryOverSource } from "@/lib/rolling-squad";
import { dayLabel } from "@/lib/i18n/dates";
import { TeamDisplay } from "@/components/match/team-display";
import { isOrgAdmin } from "@/lib/org";
import { resolveTeamLabels } from "@/lib/team-labels";
import { format } from "date-fns";
import { formatLondon } from "@/lib/london-time";
import { Calendar, MapPin, Clock, Star, ChevronRight } from "lucide-react";
import { t } from "@/lib/i18n/t";
import { canEnterScore, hasScore, scoreEntryAction, shouldOpenScorePanel, SCORE_PANEL_PARAM } from "@/lib/score-entry";
import { ScoreEntryPanel } from "@/components/match/score-entry-panel";
import { buildWeekList } from "@/lib/monthly-week-rules";
import { PartnerAskPanel } from "@/components/match/partner-ask-panel";
import { PartnerGuestsPanel } from "@/components/match/partner-guests-panel";
import { loadPartnerAskPanel } from "@/lib/partner-ask";
import { poolEnvForRequest } from "@/lib/pool/switch-env";
import { organisersPickMom } from "@/lib/mom-chooser";
import { loadMatchGuestCards } from "@/lib/pool/guest-report-loader";
import { loadGuestResultsPanel, markByLabel } from "@/lib/pool/no-shows";
import { GuestResultsPanel } from "@/components/match/guest-results-panel";
import { normaliseLang } from "@/lib/i18n/lang";

export default async function MatchDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ matchId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { matchId } = await params;
  // `?score=1` from a result list's "Add score" opens the score panel.
  const openScorePanel = shouldOpenScorePanel((await searchParams)[SCORE_PANEL_PARAM]);
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: { include: { sport: true, org: { select: { name: true, teamLabels: true, language: true, momChosenBy: true, featurePlayerPool: true } } } },
      attendances: {
        where: { status: { in: ["CONFIRMED", "BENCH"] } },
        include: {
          user: {
            include: { activityPositions: true },
          },
        },
        orderBy: { position: "asc" },
      },
      teamAssignments: {
        include: {
          user: {
            include: { activityPositions: true },
          },
        },
      },
      momVotes: true,
    },
  });
  if (!match) redirect("/matches");

  const sport = match.activity.sport;
  const [redLabel, yellowLabel] = resolveTeamLabels(match, match.activity.org, sport, match.activity.org.language);

  // Per-activity positions for the players in this match
  const positionsFor = (u: { activityPositions: { activityId: string; positions: string[] }[] }) =>
    u.activityPositions.find((p) => p.activityId === match.activityId)?.positions ?? [];

  const myAttendance = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId: session.user.id } },
  });

  const isAdmin = await isOrgAdmin(session.user.id, match.activity.orgId);

  // Payments dashboard link — shown to an org admin OR the money collector
  // when the org collects fees. Lets them open /collect/<match> on demand
  // to see who's paid (instead of only via the post-match DM link).
  const orgPay = await db.organisation.findUnique({
    where: { id: match.activity.orgId },
    select: { paymentCollectionEnabled: true, paymentHolderId: true, rollingSquadEnabled: true, benchPickMode: true, squadMode: true },
  });

  // MONTHLY SQUAD (slice 6, plan 9.2): for a match of a running month the
  // page shows the month's list for this game: who is a regular (and has
  // paid), who pays per game, and who has paid but can't play. A club on
  // "weekly" (Sutton FC and every club before this) makes no query here
  // and renders exactly what it did.
  const monthlyWeek =
    orgPay?.squadMode === "monthly"
      ? await import("@/lib/monthly-week").then((m) => m.loadMonthlyWeek(matchId)).catch(() => null)
      : null;
  const monthList = monthlyWeek ? buildWeekList({ members: monthlyWeek.members, rows: monthlyWeek.rows, maxPlayers: monthlyWeek.maxPlayers }) : null;
  const ms = t(match.activity.org.language);

  // Organiser pick (slice 2b, plan 2.13): admins of such a club see the
  // waiting list with position and club rating (the number players see,
  // never the seed), and can reorder it and bring someone in.
  const organiserPicks = isAdmin && orgPay?.benchPickMode === "organiser";
  const waitingRows = organiserPicks
    ? await (async () => {
        const bench = match.attendances.filter((a) => a.status === "BENCH");
        const ids = bench.map((a) => a.userId);
        const ratings = ids.length
          ? await db.rating.findMany({
              where: { playerId: { in: ids }, match: { activity: { orgId: match.activity.orgId } } },
              orderBy: { createdAt: "desc" },
              select: { playerId: true, matchId: true, score: true },
            })
          : [];
        const summary = summariseClubDisplayRatings(ids, ratings, 60);
        return bench.map((a) => ({
          userId: a.userId,
          name: a.user.name ?? "?",
          position: positionLabel(positionsFor(a.user)),
          rating: summary[a.userId]?.rating ?? null,
        }));
      })()
    : [];

  // Rolling squad (2026-09-30): an admin of a rolling club can copy the
  // last played squad onto an EMPTY match (a club's first week on
  // MatchTime, or back from a break). `findCarryOverSource` returns null
  // whenever the button does not apply.
  const carryOverSource =
    isAdmin && orgPay?.rollingSquadEnabled ? await findCarryOverSource(matchId) : null;
  const canSeePayments =
    !!orgPay?.paymentCollectionEnabled &&
    (isAdmin || orgPay.paymentHolderId === session.user.id);

  // Existing org members not already in this match — for the admin
  // "add player" picker, so they select rather than retype (avoids dupes).
  const inMatchIds = new Set(match.attendances.map((a) => a.userId));
  const addablePlayers = isAdmin
    ? (
        await db.membership.findMany({
          where: { orgId: match.activity.orgId, leftAt: null },
          select: { user: { select: { id: true, name: true, phoneNumber: true } } },
        })
      )
        .map((m) => m.user)
        .filter((u) => u.name && !inMatchIds.has(u.id))
        .map((u) => ({ id: u.id, name: u.name as string, hasPhone: !!u.phoneNumber }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  // Ask a partner club (cross-club ask, slice S2): admins of a club with an
  // active partner and asking switched on, for a match still to play.
  const partnerAskPanel =
    isAdmin && ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"].includes(match.status)
      ? await loadPartnerAskPanel(matchId, match.activity.orgId, { poolEnv: await poolEnvForRequest() }).catch(() => null)
      : null;
  // Guests on this match (S4; the player pool, L5a): name and where he came
  // from (a partner club's name, or "MatchTime player pool"), never a phone,
  // with "Add to <club>". A partner guest's standing at HIS club; a pool
  // guest has no home club, so none. Admins only.
  const partnerGuestRows = isAdmin
    ? await (async () => {
        const ids = match.attendances.map((a) => a.userId);
        if (ids.length === 0) return [];
        const guests = await db.membership
          .findMany({
            where: { orgId: match.activity.orgId, userId: { in: ids }, ...GUEST_MEMBER_WHERE },
            select: { userId: true, guestFromOrgId: true, guestMatchId: true, guestVia: true },
          })
          .catch(() => []);
        if (guests.length === 0) return [];
        const homes = guests.map((g) => ({ userId: g.userId, homeOrgId: partnerHomeClubOf(g) })).filter((g): g is { userId: string; homeOrgId: string } => !!g.homeOrgId);
        const clubs = homes.length ? await db.organisation.findMany({ where: { id: { in: homes.map((h) => h.homeOrgId) } }, select: { id: true, name: true } }) : [];
        const nameOf = new Map(clubs.map((c) => [c.id, c.name]));
        // His standing at HIS club (2026-10-22, option C), in this club's words.
        const standings = homes.length ? await loadGuestStandings(homes) : new Map();
        const poolLabel = t(match.activity.org.language).gst_source_pool;
        return guests.map((g) => {
          const st = standings.get(g.userId);
          const home = partnerHomeClubOf(g);
          return {
            userId: g.userId,
            name: match.attendances.find((a) => a.userId === g.userId)?.user.name ?? "?",
            club: guestSourceOf(g) === "pool" ? poolLabel : home ? (nameOf.get(home) ?? "") : "",
            standing: st ? standingPhrase(match.activity.org.language, st) : null,
          };
        });
      })()
    : [];
  // Guest tags on the attendance list (pool slice L5b): every viewer sees the
  // tag; an organiser's opens the guest card.
  const guestTags = await loadMatchGuestCards({
    orgId: match.activity.orgId,
    matchId,
    attendeeIds: match.attendances.map((a) => a.userId),
    lang: normaliseLang(match.activity.org.language),
    admin: isAdmin,
  }).catch(() => ({}));
  // Did the guests turn up? (pool slice L7): organisers, from kickoff, in a
  // club that may ask the pool (every other club's page is as before).
  const poolClub = match.activity.org.featurePlayerPool === true;
  const guestResults = isAdmin && poolClub ? await loadGuestResultsPanel(match.activity.orgId, matchId).catch(() => null) : null;
  const isPastDeadline = new Date() > match.attendanceDeadline;
  // "Enter score" / "Edit score" for an admin on any PLAYED match that was
  // not cancelled (FNF, 2026-10-18). Both open the score panel in the
  // result bar (Kemal, 2026-10-18); the teams page keeps its own box.
  const scoreAction = isAdmin ? scoreEntryAction(match) : null;
  const hasTeams = match.teamAssignments.length > 0;

  // Block "I'm in" on a future match while a previous scheduled
  // match in the same org is still in flight (not yet COMPLETED).
  // Mirrors the server-side guard in src/lib/attendance.ts so the
  // button is greyed out instead of throwing on click.
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const blockedByPriorMatch =
    match.date >= todayStart &&
    !!(await db.match.findFirst({
      where: {
        activity: { orgId: match.activity.orgId },
        status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
        date: { lt: todayStart },
        id: { not: matchId },
      },
      select: { id: true },
    }));

  const redTeam = match.teamAssignments
    .filter((a) => a.team === "RED")
    .map((a) => ({ ...a.user, positions: positionsFor(a.user) }));
  const yellowTeam = match.teamAssignments
    .filter((a) => a.team === "YELLOW")
    .map((a) => ({ ...a.user, positions: positionsFor(a.user) }));

  const ratingWindowEnd = new Date(
    match.date.getTime() + match.activity.ratingWindowHours * 60 * 60 * 1000,
  );
  const canRate =
    match.status === "COMPLETED" &&
    new Date() < ratingWindowEnd &&
    myAttendance?.status === "CONFIRMED";

  const existingRatings = await db.rating.count({
    where: { matchId, raterId: session.user.id },
  });

  // MoM tally — handle ties at the top explicitly. The DB's `orderBy
  // _count desc` is not deterministic when two players have the same
  // count, so we sort by name as a tiebreaker for stable display.
  const momRows =
    match.status === "COMPLETED"
      ? await db.moMVote.groupBy({
          by: ["playerId"],
          where: { matchId },
          _count: { playerId: true },
        })
      : [];
  const momPlayerIds = momRows.map((r) => r.playerId);
  const momUsers = momPlayerIds.length
    ? await db.user.findMany({
        where: { id: { in: momPlayerIds } },
        select: { id: true, name: true },
      })
    : [];
  const momUserById = new Map(momUsers.map((u) => [u.id, u.name ?? "Unknown"]));
  const momTally = momRows
    .map((r) => ({
      playerId: r.playerId,
      name: momUserById.get(r.playerId) ?? "Unknown",
      votes: r._count.playerId,
    }))
    .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
  const momTotalVotes = momTally.reduce((s, r) => s + r.votes, 0);
  const momTopCount = momTally[0]?.votes ?? 0;
  const momTopPlayers = momTally.filter((r) => r.votes === momTopCount);
  const momOthers = momTally.filter((r) => r.votes < momTopCount);
  // Each voter casts at most one MoMVote, so vote count == voter count.
  const momConfirmedCount = match.attendances.filter((a) => a.status === "CONFIRMED").length;
  // The organisers pick Man of the Match in this club (mom-chooser.ts): a
  // name, never a vote count.
  const momPicked = organisersPickMom({ momChosenBy: match.activity.org.momChosenBy });

  const statusLabel = match.status.replace(/_/g, " ").toLowerCase();
  const statusPill =
    match.status === "COMPLETED"
      ? "bg-green-100 text-green-700"
      : match.status === "TEAMS_PUBLISHED"
      ? "bg-blue-100 text-blue-700"
      : match.status === "TEAMS_GENERATED"
      ? "bg-amber-100 text-amber-700"
      : "bg-slate-100 text-slate-600";

  // The result bar (Kemal, 2026-10-18): on a PLAYED match that was not
  // cancelled, the result and the admin actions (enter or edit the score,
  // who's paid) and the rate button sit right under the header. They used
  // to sit below the team sheets and the full attendance list, where an
  // admin on a phone had to scroll a long way to find them. Each action
  // appears once: what the bar shows is left out of the bottom row.
  const scored = hasScore(match);
  const showResultBar = canEnterScore(match) && (scored || !!scoreAction || canSeePayments || canRate);

  const paymentsLink = canSeePayments && (
    <Link
      href={`/collect/${matchId}`}
      data-testid="payments-link"
      className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
    >
      Payments · who&apos;s paid
      <ChevronRight className="w-4 h-4" />
    </Link>
  );

  return (
    <div className="p-6 sm:p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">{match.activity.name}</h1>
          <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 mt-2 text-sm text-slate-500">
            <span className="flex items-center gap-1.5">
              <Calendar className="w-4 h-4" />
              {formatLondon(match.date, "EEEE, d MMMM yyyy 'at' HH:mm")}
            </span>
            <span className="flex items-center gap-1.5">
              <MapPin className="w-4 h-4" />
              {match.activity.venue}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex px-2.5 py-1 rounded-md bg-slate-100 text-slate-600 text-xs font-medium">
            {sport.name}
          </span>
          <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium capitalize ${statusPill}`}>
            {statusLabel}
          </span>
        </div>
      </div>

      {/* Result bar: the score and the actions for a played match */}
      {showResultBar && (
        <section
          data-testid="match-result-bar"
          className="bg-white rounded-xl border border-slate-200 shadow-sm px-4 py-5 sm:px-6 sm:py-6 text-center space-y-4"
        >
          {scored ? (
            <div
              data-testid="match-result"
              className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 sm:gap-6"
            >
              <span data-testid="result-red-label" className="text-right text-base sm:text-lg font-semibold text-slate-800 break-words">
                {redLabel}
              </span>
              <span className="flex items-center gap-3 sm:gap-5 text-4xl sm:text-5xl font-bold tabular-nums whitespace-nowrap">
                <span data-testid="result-red-score" className="text-red-500">{match.redScore}</span>
                <span className="text-slate-300 text-2xl sm:text-3xl">-</span>
                <span data-testid="result-yellow-score" className="text-amber-500">{match.yellowScore}</span>
              </span>
              <span data-testid="result-yellow-label" className="text-left text-base sm:text-lg font-semibold text-slate-800 break-words">
                {yellowLabel}
              </span>
            </div>
          ) : (
            scoreAction && <p className="text-sm text-slate-500">{ms.score_entry_no_score_yet}</p>
          )}
          {scored && momTopCount > 0 && (
            <div className="mt-4 space-y-1">
              <p className="text-sm text-slate-500 flex items-center justify-center gap-1.5 flex-wrap">
                <Star className="w-4 h-4 text-amber-500 fill-amber-500" />
                {sport.mvpLabel}:{" "}
                {momTopPlayers.length > 1 ? (
                  <>
                    <span className="font-semibold text-slate-800">
                      shared between{" "}
                      {momTopPlayers
                        .map((p) => p.name)
                        .reduce<React.ReactNode[]>((acc, n, i, arr) => {
                          if (i === 0) return [n];
                          if (i === arr.length - 1) return [...acc, " and ", n];
                          return [...acc, ", ", n];
                        }, [])}
                    </span>
                    <span className="text-slate-400">
                      ({momTopCount} vote{momTopCount === 1 ? "" : "s"} each)
                    </span>
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-slate-800">{momTopPlayers[0].name}</span>
                    {momPicked ? (
                      <span className="text-slate-400">(picked by the organisers)</span>
                    ) : (
                      <span className="text-slate-400">
                        ({momTopCount} of {momTotalVotes} vote{momTotalVotes === 1 ? "" : "s"})
                      </span>
                    )}
                  </>
                )}
              </p>
              {momOthers.length > 0 && (
                <p className="text-xs text-slate-400">
                  Also received votes:{" "}
                  {momOthers.map((p, i) => (
                    <span key={p.playerId}>
                      {i > 0 && ", "}
                      {p.name} ({p.votes})
                    </span>
                  ))}
                </p>
              )}
              {!momPicked && momConfirmedCount > 0 && (
                <p className="text-xs text-slate-400">
                  {momTotalVotes} of {momConfirmedCount} player{momConfirmedCount === 1 ? "" : "s"} voted
                </p>
              )}
            </div>
          )}
          {(scoreAction || canSeePayments || canRate) && (
            <div
              data-testid="match-admin-actions"
              className="flex flex-col sm:flex-row sm:flex-wrap sm:justify-center gap-2 sm:gap-3 [&>a]:justify-center"
            >
              {scoreAction && (
                // Opens the score panel right here (Kemal, 2026-10-18), not
                // the teams page, which shows no match date.
                <ScoreEntryPanel
                  matchId={matchId}
                  lang={match.activity.org.language}
                  action={scoreAction}
                  redLabel={redLabel}
                  yellowLabel={yellowLabel}
                  redScore={match.redScore}
                  yellowScore={match.yellowScore}
                  initialOpen={openScorePanel}
                />
              )}
              {paymentsLink}
              {canRate && (
                <Link
                  href={`/matches/${matchId}/rate`}
                  className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors"
                >
                  {existingRatings > 0 ? "Update ratings" : momPicked ? "Rate players" : "Rate players & vote MoM"}
                  <ChevronRight className="w-4 h-4" />
                </Link>
              )}
            </div>
          )}
        </section>
      )}

      {/* Attend button */}
      {match.status === "UPCOMING" && (
        <div className="flex items-center gap-4 flex-wrap">
          <AttendButton
            matchId={matchId}
            currentStatus={myAttendance?.status as "CONFIRMED" | "BENCH" | "DROPPED" | null}
            isPastDeadline={isPastDeadline}
            blockedByPriorMatch={blockedByPriorMatch}
            lang={match.activity.org.language}
          />
          {!isPastDeadline && (
            <p className="text-sm text-slate-500 flex items-center gap-1.5">
              <Clock className="w-4 h-4" />
              Deadline: {formatLondon(match.attendanceDeadline, "EEE d MMM, HH:mm")}
            </p>
          )}
        </div>
      )}

      {/* Teams */}
      {hasTeams && (
        <section data-testid="teams-section">
          <h2 className="text-lg font-semibold text-slate-800 mb-4">Teams</h2>
          <TeamDisplay
            redTeam={redTeam}
            yellowTeam={yellowTeam}
            redScore={match.redScore}
            yellowScore={match.yellowScore}
            redLabel={redLabel}
            yellowLabel={yellowLabel}
          />
        </section>
      )}

      {/* The month's list for this game (monthly squad only) */}
      {monthList && (
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm" data-testid="monthly-week-panel">
          <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-slate-800">{ms.mwp_title}</h2>
            {monthList.open > 0 && (
              <span className="text-sm text-slate-500" data-testid="monthly-open">
                {ms.mwp_open({ open: monthList.open })}
              </span>
            )}
          </div>
          <div className="p-6 space-y-4">
            <ol className="space-y-1 text-sm text-slate-700">
              {monthList.slots.map((slot) => (
                <li key={slot.slot} className="flex items-center gap-2" data-testid="monthly-slot" data-slot={slot.slot}>
                  <span className="w-6 text-right text-slate-400">{slot.slot}.</span>
                  <span className="font-medium text-slate-800">{slot.name}</span>
                  {slot.userId && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        slot.mark === "payg" ? "bg-blue-50 text-blue-700" : slot.mark === "paid" ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-600"
                      }`}
                      data-testid="monthly-tag"
                      data-tag={slot.mark ?? "monthly"}
                    >
                      {slot.mark === "payg" ? ms.mwp_tag_payg : slot.mark === "paid" ? ms.mwp_tag_paid : ms.mwp_tag_monthly}
                    </span>
                  )}
                </li>
              ))}
            </ol>
            {monthList.paidCantPlay.length > 0 && (
              <div data-testid="monthly-cant-paid">
                <h3 className="text-sm font-semibold text-slate-800">{ms.mwp_cant_paid}</h3>
                <p className="text-sm text-slate-600">{monthList.paidCantPlay.map((p) => p.name).join(", ")}</p>
              </div>
            )}
            {monthList.cantPlay.length > 0 && (
              <div data-testid="monthly-cant">
                <h3 className="text-sm font-semibold text-slate-800">{ms.mwp_cant}</h3>
                <p className="text-sm text-slate-600">{monthList.cantPlay.map((p) => p.name).join(", ")}</p>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Attendance list */}
      <section data-testid="attendance-section" className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="text-lg font-semibold text-slate-800">Attendance</h2>
        </div>
        <div className="p-6 space-y-4">
          {isAdmin && <AddPlayerToMatch matchId={matchId} existingPlayers={addablePlayers} />}
          {carryOverSource && (
            <CarryOverSquadButton
              matchId={matchId}
              lang={match.activity.org.language}
              sourceDateLabel={dayLabel(match.activity.org.language, carryOverSource.date)}
            />
          )}
          <AttendanceList
            attendances={match.attendances.map((a) => ({
              ...a,
              user: { ...a.user, positions: positionsFor(a.user) },
            }))}
            maxPlayers={match.maxPlayers}
            admin={isAdmin}
            matchId={matchId}
            hideBench={organiserPicks}
            guests={{ lang: match.activity.org.language, orgId: match.activity.orgId, byUser: guestTags, matchId, poolClub }}
          />
          {organiserPicks && (
            <WaitingListControls matchId={matchId} lang={match.activity.org.language} rows={waitingRows} />
          )}
        </div>
      </section>

      {guestResults && (
        <GuestResultsPanel
          matchId={matchId}
          lang={match.activity.org.language}
          until={markByLabel(match.activity.org.language, guestResults.closesAt)}
          final={guestResults.final}
          rows={guestResults.rows}
        />
      )}

      {partnerGuestRows.length > 0 && (
        <PartnerGuestsPanel matchId={matchId} clubName={match.activity.org.name} language={match.activity.org.language} rows={partnerGuestRows} />
      )}

      {partnerAskPanel && (partnerAskPanel.rows.length > 0 || partnerAskPanel.pool) && (
        <PartnerAskPanel
          matchId={matchId}
          language={match.activity.org.language}
          placesOpen={partnerAskPanel.placesOpen}
          rows={partnerAskPanel.rows}
          rounds={partnerAskPanel.rounds}
          pool={partnerAskPanel.pool}
        />
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-3">
        {!showResultBar && paymentsLink}
        {isAdmin && match.status === "UPCOMING" && isPastDeadline && (
          <Link
            href={`/admin/matches/${matchId}/teams`}
            className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
          >
            Generate teams
          </Link>
        )}
        {isAdmin && (match.status === "TEAMS_GENERATED" || match.status === "TEAMS_PUBLISHED") && (
          <Link
            href={`/admin/matches/${matchId}/teams`}
            className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
          >
            Manage teams
          </Link>
        )}
        {isAdmin &&
          (match.status === "UPCOMING" ||
            match.status === "TEAMS_GENERATED" ||
            match.status === "TEAMS_PUBLISHED") && (
            <Link
              href={`/admin/matches/${matchId}/switch-format`}
              className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
            >
              Switch format
            </Link>
          )}
      </div>
    </div>
  );
}
