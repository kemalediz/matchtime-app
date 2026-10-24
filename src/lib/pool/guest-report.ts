/**
 * THE GUEST PLAYERS PAGE'S READ MODEL (slice L5b, 2026-10-24). PURE.
 *
 * Approved spec, "Guest players in the app": each club's admin area has a
 * Guest players page (Upcoming, History, Report), match pages tag guests,
 * and a guest card shows first name, last initial, sports, optional level,
 * turn-up record and games with this club. Phone, area and other clubs are
 * never shown: nothing here carries them (the loader never selects them,
 * `guest-report-loader.ts`).
 *
 * ONE RULE FOR TWO SOURCES. A guest's game is a `GuestPlace` row (decision
 * log #7: written for pool and partner guests from L5 on) or, for a partner
 * guest from before the pool, his attendance row on the club's match while
 * he holds a guest membership there (`recorded` null). `settleGuestResult`
 * turns both into one `GuestResult`, so every tab, the card and the report
 * read the same answer.
 *
 * THE REPORT (one row per London month, or per season 1 Aug to 31 Jul):
 *   asked          people put the question directly: every pool offer that
 *                  reached a player, plus every partner club player who
 *                  answered his club's post (a post in a group reaches
 *                  people MatchTime cannot count).
 *   accepted       guest places taken, whatever happened next (booked,
 *                  played, no-show, late cancel, withdrawn).
 *   played         turned up.
 *   no-shows       confirmed and did not come.
 *   became members distinct guests who are members of this club now,
 *                  counted once, in the period of their first game here.
 *   short games    decided matches (played, or cancelled) the club asked
 *                  guests for: a pool ask or a partner ask that was not
 *                  cancelled or refused. A match still to play is not
 *                  decided and is left out. A cancelled match counts: it
 *                  was short and nobody rescued it.
 *   rescued        short games in which at least one guest played.
 *   fill rate      rescued / short games. Null (shown as a dash) when the
 *                  club had no short game, never 0.
 * Every row is bucketed by the MATCH's kickoff, so a row adds up.
 */
import { formatLondon, londonDateTimeToUtc } from "../london-time";
import type { Lang } from "../i18n/lang";
import { levelLabel, sportLabel, type PoolSportChoiceKey, type SportLevel } from "./sports";
import { turnUpRecordOf, type TurnUpRecord } from "./turn-up";
import { inviteToClubState, type GuestPoolState, type InviteToClubState } from "./club-invite";
import type { GuestResult, GuestSource } from "./vocab";

export type MatchStatusLike = "UPCOMING" | "TEAMS_GENERATED" | "TEAMS_PUBLISHED" | "COMPLETED" | "CANCELLED";
export type AttendanceLike = "CONFIRMED" | "BENCH" | "DROPPED";

export interface GuestMatchFacts {
  matchId: string;
  kickoff: Date;
  durationMins: number;
  status: MatchStatusLike;
  /** The club's Sport row and its name. Empty for another club's match. */
  sportId: string;
  sportName: string;
  /** The venue's name. Empty for another club's match. */
  venue: string;
}

/** One guest's game, at this club or (for his turn-up record only) another. */
export interface GuestGameFact {
  userId: string;
  orgId: string;
  match: GuestMatchFacts;
  /** His attendance row on the match, if any. */
  attendance: AttendanceLike | null;
  /** `GuestPlace.result`; null for a pre-pool partner guest's game. */
  recorded: GuestResult | null;
  source: GuestSource;
  /** The partner club he came from (this club's partner): partner only. */
  fromClub: string | null;
}

/** One sport from his pool profile. */
export interface GuestSportFact {
  sport: PoolSportChoiceKey;
  otherName: string;
  level: SportLevel | null;
  levelText: string | null;
}

export interface GuestPersonFacts {
  userId: string;
  name: string | null;
  /** A live, ordinary (non-guest) member of this club now. */
  member: boolean;
  pool: GuestPoolState;
  poolSports: GuestSportFact[];
  /** An open `ClubInvitation` from this club. */
  openInvitation: boolean;
}

// ── One result per game ────────────────────────────────────────────────

/** Played (COMPLETED) or over: kickoff plus its length has passed. */
export function matchEnded(m: Pick<GuestMatchFacts, "kickoff" | "durationMins" | "status">, now: Date): boolean {
  if (m.status === "COMPLETED") return true;
  return now.getTime() >= m.kickoff.getTime() + m.durationMins * 60_000;
}

/**
 * How his game went, or null when it was not a game: the match was
 * cancelled, or he sat on the bench and was never called up. A recorded
 * outcome (an organiser's no-show, a late cancel) wins; a place still
 * "booked" is read from his attendance row, as a pre-pool game is.
 */
export function settleGuestResult(g: Pick<GuestGameFact, "match" | "attendance" | "recorded">, now: Date): GuestResult | null {
  if (g.match.status === "CANCELLED") return null;
  if (g.recorded && g.recorded !== "booked") return g.recorded;
  if (!matchEnded(g.match, now)) return g.attendance === "DROPPED" ? "withdrawn" : "booked";
  if (g.attendance === "CONFIRMED") return "played";
  if (g.attendance === "DROPPED") return "withdrawn";
  return null;
}

/** "Ali Khan" -> "Ali K". Null when there is no name. */
export function guestDisplayName(name: string | null | undefined): string | null {
  const words = (name ?? "").replace(/\./g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  if (words.length === 1) return words[0];
  return `${words[0]} ${words[words.length - 1].charAt(0).toLocaleUpperCase()}`;
}

// ── Upcoming, History, cards ───────────────────────────────────────────

export interface GuestCard {
  userId: string;
  /** First name and last initial; null when he has no name. */
  name: string | null;
  /** Where his latest game here came from. */
  source: GuestSource;
  fromClub: string | null;
  sports: { label: string; level: string | null }[];
  /** Across every club, counts only. */
  record: TurnUpRecord;
  /** Games he played with this club. */
  gamesHere: number;
  invite: InviteToClubState;
}

export interface UpcomingGroup {
  matchId: string;
  kickoff: Date;
  venue: string;
  sportName: string;
  guests: { userId: string; onBench: boolean }[];
}

export interface HistoryRow {
  userId: string;
  joined: boolean;
  games: { matchId: string; kickoff: Date; venue: string; result: GuestResult }[];
}

export interface GuestPlayers {
  cards: Record<string, GuestCard>;
  upcoming: UpcomingGroup[];
  history: HistoryRow[];
}

interface Settled extends GuestGameFact {
  result: GuestResult;
}

const settleAll = (games: readonly GuestGameFact[], now: Date): Settled[] =>
  games.flatMap((g) => {
    const result = settleGuestResult(g, now);
    return result ? [{ ...g, result }] : [];
  });

const byKickoff = (a: { kickoff: Date }, b: { kickoff: Date }) => a.kickoff.getTime() - b.kickoff.getTime();

export function buildGuestPlayers(input: {
  orgId: string;
  now: Date;
  lang: Lang;
  games: readonly GuestGameFact[];
  people: readonly GuestPersonFacts[];
}): GuestPlayers {
  const all = settleAll(input.games, input.now);
  const here = all.filter((g) => g.orgId === input.orgId);
  const people = new Map(input.people.map((p) => [p.userId, p]));

  const cards: Record<string, GuestCard> = {};
  for (const p of input.people) {
    const mine = here.filter((g) => g.userId === p.userId).sort((a, b) => byKickoff(a.match, b.match));
    if (mine.length === 0) continue;
    const latest = mine[mine.length - 1];
    const gamesHere = mine.filter((g) => g.result === "played").length;
    const sports =
      p.poolSports.length > 0
        ? p.poolSports.map((s) => ({
            label: s.sport === "other" ? s.otherName || sportLabel("other", input.lang) : sportLabel(s.sport, input.lang),
            level: s.level ? levelLabel(s.level, input.lang) : s.levelText || null,
          }))
        : [...new Set(mine.map((g) => g.match.sportName).filter(Boolean))].map((label) => ({ label, level: null }));
    cards[p.userId] = {
      userId: p.userId,
      name: guestDisplayName(p.name),
      source: latest.source,
      fromClub: latest.source === "partner" ? latest.fromClub : null,
      sports,
      record: turnUpRecordOf(all.filter((g) => g.userId === p.userId).map((g) => g.result)),
      gamesHere,
      invite: inviteToClubState({ member: p.member, playedHere: gamesHere, openInvitation: p.openInvitation, pool: p.pool }),
    };
  }

  const nameOf = (id: string) => cards[id]?.name ?? "￿";
  const byName = (a: string, b: string) => nameOf(a).localeCompare(nameOf(b)) || a.localeCompare(b);

  const groups = new Map<string, UpcomingGroup>();
  for (const g of here) {
    if (g.result !== "booked" || !cards[g.userId]) continue;
    const grp = groups.get(g.match.matchId) ?? { matchId: g.match.matchId, kickoff: g.match.kickoff, venue: g.match.venue, sportName: g.match.sportName, guests: [] };
    grp.guests.push({ userId: g.userId, onBench: g.attendance === "BENCH" });
    groups.set(g.match.matchId, grp);
  }
  const upcoming = [...groups.values()].sort(byKickoff);
  for (const grp of upcoming) grp.guests.sort((a, b) => byName(a.userId, b.userId));

  const history: HistoryRow[] = [];
  for (const userId of Object.keys(cards)) {
    const past = here
      .filter((g) => g.userId === userId && matchEnded(g.match, input.now))
      .sort((a, b) => byKickoff(b.match, a.match))
      .map((g) => ({ matchId: g.match.matchId, kickoff: g.match.kickoff, venue: g.match.venue, result: g.result }));
    if (past.length > 0) history.push({ userId, joined: people.get(userId)?.member === true, games: past });
  }
  history.sort((a, b) => b.games[0].kickoff.getTime() - a.games[0].kickoff.getTime() || byName(a.userId, b.userId));

  return { cards, upcoming, history };
}

// ── The report ─────────────────────────────────────────────────────────

export type ReportPeriod = "month" | "season";
export const REPORT_PERIODS: readonly ReportPeriod[] = ["month", "season"];

/** A London calendar month ("2026-10") or a season from 1 August ("2026/27"). */
export function periodOf(d: Date, period: ReportPeriod): { key: string; start: Date } {
  const y = Number(formatLondon(d, "yyyy"));
  const m = Number(formatLondon(d, "MM"));
  if (period === "month") {
    const mm = String(m).padStart(2, "0");
    return { key: `${y}-${mm}`, start: londonDateTimeToUtc(`${y}-${mm}-01`, "00:00") };
  }
  const from = m >= 8 ? y : y - 1;
  return { key: `${from}/${String((from + 1) % 100).padStart(2, "0")}`, start: londonDateTimeToUtc(`${from}-08-01`, "00:00") };
}

/** One club ask for one match. `reached`: pool offers that reached a
 *  player, or the partner club players who answered. */
export interface ReportAskFact {
  matchId: string;
  kind: "pool" | "partner";
  status: string;
  reached: number;
}

/** Did this ask mean the club was short? Not when it was withdrawn (the
 *  club filled the place itself) or the partner refused it. */
export function askCountsAsShort(a: Pick<ReportAskFact, "kind" | "status">): boolean {
  return a.kind === "pool" ? a.status !== "cancelled" : a.status !== "cancelled" && a.status !== "refused";
}

export interface ReportFilters {
  period: ReportPeriod;
  sportId?: string | null;
  venue?: string | null;
}

export interface ReportRow {
  key: string;
  start: Date;
  asked: number;
  accepted: number;
  played: number;
  noShows: number;
  becameMembers: number;
  shortGames: number;
  rescued: number;
  fillRate: number | null;
}

export interface GuestReport {
  rows: ReportRow[];
  total: ReportRow;
}

const emptyRow = (key: string, start: Date): ReportRow => ({
  key,
  start,
  asked: 0,
  accepted: 0,
  played: 0,
  noShows: 0,
  becameMembers: 0,
  shortGames: 0,
  rescued: 0,
  fillRate: null,
});

const withRate = (r: ReportRow): ReportRow => ({ ...r, fillRate: r.shortGames > 0 ? r.rescued / r.shortGames : null });

export function buildGuestReport(
  input: {
    orgId: string;
    now: Date;
    games: readonly GuestGameFact[];
    asks: readonly ReportAskFact[];
    /** Every match of this club that has an ask or a guest game. */
    matches: readonly GuestMatchFacts[];
    /** Guests who are members of this club now. */
    members: ReadonlySet<string>;
  },
  filters: ReportFilters,
): GuestReport {
  const keep = (m: GuestMatchFacts) => (!filters.sportId || m.sportId === filters.sportId) && (!filters.venue || m.venue === filters.venue);
  const matches = new Map(input.matches.filter(keep).map((m) => [m.matchId, m]));
  const games = settleAll(
    input.games.filter((g) => g.orgId === input.orgId && matches.has(g.match.matchId)),
    input.now,
  );

  const rows = new Map<string, ReportRow>();
  const rowOf = (m: GuestMatchFacts): ReportRow => {
    const p = periodOf(m.kickoff, filters.period);
    const r = rows.get(p.key) ?? emptyRow(p.key, p.start);
    rows.set(p.key, r);
    return r;
  };

  for (const a of input.asks) {
    const m = matches.get(a.matchId);
    if (m) rowOf(m).asked += a.reached;
  }
  for (const g of games) {
    const r = rowOf(g.match);
    r.accepted++;
    if (g.result === "played") r.played++;
    if (g.result === "no-show") r.noShows++;
  }

  const firstGame = new Map<string, Settled>();
  for (const g of [...games].sort((a, b) => byKickoff(a.match, b.match))) if (!firstGame.has(g.userId)) firstGame.set(g.userId, g);
  for (const [userId, g] of firstGame) if (input.members.has(userId)) rowOf(g.match).becameMembers++;

  const shortIds = new Set(input.asks.filter((a) => matches.has(a.matchId) && askCountsAsShort(a)).map((a) => a.matchId));
  const playedIn = new Set(games.filter((g) => g.result === "played").map((g) => g.match.matchId));
  for (const id of shortIds) {
    const m = matches.get(id)!;
    if (m.status !== "CANCELLED" && !matchEnded(m, input.now)) continue;
    const r = rowOf(m);
    r.shortGames++;
    if (m.status !== "CANCELLED" && playedIn.has(id)) r.rescued++;
  }

  const sorted = [...rows.values()].sort((a, b) => b.start.getTime() - a.start.getTime()).map(withRate);
  const total = sorted.reduce<ReportRow>(
    (t, r) => ({
      ...t,
      asked: t.asked + r.asked,
      accepted: t.accepted + r.accepted,
      played: t.played + r.played,
      noShows: t.noShows + r.noShows,
      becameMembers: t.becameMembers + r.becameMembers,
      shortGames: t.shortGames + r.shortGames,
      rescued: t.rescued + r.rescued,
    }),
    emptyRow("total", sorted.at(-1)?.start ?? input.now),
  );
  return { rows: sorted, total: withRate(total) };
}

/** The Report's filter choices: the club's sports and venues with guests or asks. */
export function reportFilterOptions(matches: readonly GuestMatchFacts[]): { sports: { id: string; name: string }[]; venues: string[] } {
  const sports = new Map<string, string>();
  const venues = new Set<string>();
  for (const m of matches) {
    if (m.sportId) sports.set(m.sportId, m.sportName);
    if (m.venue) venues.add(m.venue);
  }
  return {
    sports: [...sports].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    venues: [...venues].sort((a, b) => a.localeCompare(b)),
  };
}

/** A fill rate as the page and the CSV show it: "33%", or null for none. */
export function fillRatePercent(rate: number | null): string | null {
  return rate === null ? null : `${Math.round(rate * 100)}%`;
}

/** A cell, quoted when it must be, and never read as a spreadsheet formula. */
function csvCell(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The Report as CSV (RFC 4180, CRLF): the header, each period, the total. */
export function guestReportCsv(
  report: GuestReport,
  labels: { header: readonly string[]; periodLabel: (key: string) => string; totalLabel: string },
): string {
  const line = (label: string, r: ReportRow) =>
    [label, r.asked, r.accepted, r.played, r.noShows, r.becameMembers, r.shortGames, r.rescued, fillRatePercent(r.fillRate) ?? ""].map(csvCell).join(",");
  return [labels.header.map(csvCell).join(","), ...report.rows.map((r) => line(labels.periodLabel(r.key), r)), line(labels.totalLabel, report.total)]
    .map((l) => `${l}\r\n`)
    .join("");
}

// ── The page's URL ─────────────────────────────────────────────────────

export const GUEST_PAGE_TABS = ["upcoming", "history", "report"] as const;
export type GuestPageTab = (typeof GUEST_PAGE_TABS)[number];

export interface GuestPageQuery {
  tab: GuestPageTab;
  period: ReportPeriod;
  sportId: string | null;
  venue: string | null;
}

type Query = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? "")).trim();

/** The tab and the report's filters, from `?tab=&period=&sport=&venue=`. */
export function parseGuestPageQuery(q: Query): GuestPageQuery {
  const tab = first(q.tab);
  const period = first(q.period);
  return {
    tab: (GUEST_PAGE_TABS as readonly string[]).includes(tab) ? (tab as GuestPageTab) : "upcoming",
    period: (REPORT_PERIODS as readonly string[]).includes(period) ? (period as ReportPeriod) : "month",
    sportId: first(q.sport) || null,
    venue: first(q.venue) || null,
  };
}
