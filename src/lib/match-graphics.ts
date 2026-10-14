/**
 * THE DATA BEHIND THE LIST POSTER AND THE TEAM SHEET (2026-10-14).
 *
 * One read per graphic, of one match, through its club (a match id from
 * another club is simply not found). What it returns is everything the
 * renderer may draw, and nothing else:
 *
 *   - the club's name and language, the match day, kickoff (London) and
 *     venue;
 *   - the list: CONFIRMED players in squad order, the BENCH as reserves;
 *   - the teams: each TeamAssignment of a player still CONFIRMED, under
 *     the team labels the rest of the product uses (`resolveTeamLabels`).
 *
 * Names are FIRST NAMES ONLY (`displayNames`): the user's `name` is the
 * only field read off a user, so a phone number, a rating or a seed cannot
 * reach an image even by accident.
 */
import { db } from "./db";
import { formatLondon } from "./london-time";
import { normaliseLang, type Lang } from "./i18n/lang";
import { resolveTeamLabels } from "./team-labels";
import { selectRegistrationMatch } from "./registration-match-select";
import { displayNames } from "./match-graphics-layout";
import type { GraphicTarget } from "./graphic-token";

export interface GraphicBase {
  clubName: string;
  lang: Lang;
  matchDate: Date;
  /** "21:00", London. */
  kickoff: string;
  venue: string;
}

export interface ListPosterData extends GraphicBase {
  kind: "list";
  players: string[];
  reserves: string[];
}

export interface TeamSheetData extends GraphicBase {
  kind: "teams";
  teams: [{ label: string; names: string[] }, { label: string; names: string[] }];
}

export type GraphicData = ListPosterData | TeamSheetData;

/**
 * The match a command means by "the next match": the club's active
 * registration match, the same one the squad commands write to.
 */
export async function nextGraphicMatch(orgId: string, now: Date): Promise<string | null> {
  const candidates = await db.match.findMany({
    where: { activity: { orgId }, status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
    select: { id: true, date: true, status: true },
    orderBy: { date: "asc" },
  });
  return selectRegistrationMatch(candidates, now)?.id ?? null;
}

/** The graphic's data, or null: no such match at this club, or (teams) no teams yet. */
export async function loadGraphicData(target: GraphicTarget): Promise<GraphicData | null> {
  const match = await db.match.findFirst({
    where: { id: target.matchId, activity: { orgId: target.orgId } },
    select: {
      id: true,
      date: true,
      teamLabels: true,
      activity: {
        select: {
          venue: true,
          sport: { select: { teamLabels: true } },
          org: { select: { name: true, language: true, teamLabels: true } },
        },
      },
      attendances: {
        where: { status: { in: ["CONFIRMED", "BENCH"] } },
        select: { userId: true, status: true, position: true, respondedAt: true, user: { select: { id: true, name: true } } },
        orderBy: [{ position: "asc" }, { respondedAt: "asc" }],
      },
      teamAssignments: { select: { userId: true, team: true } },
    },
  });
  if (!match) return null;

  const org = match.activity.org;
  const lang = normaliseLang(org.language);
  const base: GraphicBase = {
    clubName: org.name.trim(),
    lang,
    matchDate: match.date,
    kickoff: formatLondon(match.date, "HH:mm"),
    venue: (match.activity.venue ?? "").trim(),
  };

  const confirmed = match.attendances.filter((a) => a.status === "CONFIRMED");

  if (target.kind === "list") {
    const bench = match.attendances.filter((a) => a.status === "BENCH");
    const names = displayNames(
      [...confirmed, ...bench].map((a) => ({ id: a.userId, name: a.user.name })),
      lang,
    );
    return {
      kind: "list",
      ...base,
      players: confirmed.map((a) => names.get(a.userId)!),
      reserves: bench.map((a) => names.get(a.userId)!),
    };
  }

  const teamOf = new Map(match.teamAssignments.map((t) => [t.userId, t.team]));
  const onTeams = confirmed.filter((a) => teamOf.has(a.userId));
  if (onTeams.length === 0) return null;
  const names = displayNames(
    onTeams.map((a) => ({ id: a.userId, name: a.user.name })),
    lang,
  );
  const [red, yellow] = resolveTeamLabels(match, org, match.activity.sport, lang);
  const pick = (team: "RED" | "YELLOW") => onTeams.filter((a) => teamOf.get(a.userId) === team).map((a) => names.get(a.userId)!);
  return {
    kind: "teams",
    ...base,
    teams: [
      { label: red, names: pick("RED") },
      { label: yellow, names: pick("YELLOW") },
    ],
  };
}
