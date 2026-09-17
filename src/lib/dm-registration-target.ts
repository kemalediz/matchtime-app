/**
 * Which match does a COLD DM attendance statement land on? (2026-08-31)
 *
 * The group path answers this with `selectRegistrationMatch` (soonest
 * upcoming in the current cycle, regardless of fullness, blocked while a
 * previous match is still in flight). A DM must land on EXACTLY the same
 * match — one source of truth, no parallel selection logic. This module is
 * only the DB plumbing around that pure selector.
 *
 * Also the gate that decides whether it is worth asking the LLM at all: no
 * active match, or an org that does not track attendance, means there is
 * nothing to register and the DM falls through untouched.
 */
import { db } from "./db";
import { getOrgFeatures } from "./org-features";
import { selectRegistrationMatch } from "./registration-match-select";
import { dayCommaTimeLabel } from "./i18n/dates";
import type { Lang } from "./i18n/lang";

export interface DmRegistrationTarget {
  matchId: string;
  orgId: string;
  clubName: string;
  matchName: string;
  /** `dayCommaTimeLabel(lang, date)`: "Tue 8 Sep, 21:30", London, in the
   *  org's language. */
  matchWhen: string;
  maxPlayers: number;
  /** The org's language (`Organisation.language`): the ack to the player
   *  is written in it. */
  lang: Lang;
}

/**
 * The active registration match for this user, across every org they are
 * still a member of. When several orgs qualify (rare) the soonest kick-off
 * wins — the same "soonest" rule the selector itself uses.
 */
export async function findDmRegistrationTarget(
  userId: string,
): Promise<DmRegistrationTarget | null> {
  const memberships = await db.membership.findMany({
    where: { userId, leftAt: null },
    select: { orgId: true, org: { select: { name: true } } },
  });
  if (memberships.length === 0) return null;

  let best: (DmRegistrationTarget & { date: Date }) | null = null;

  for (const mem of memberships) {
    // Attendance-off orgs (MoM/ratings only) have no squad to join.
    const features = await getOrgFeatures(mem.orgId);
    if (!features.attendance) continue;

    const candidates = await db.match.findMany({
      where: {
        activity: { orgId: mem.orgId },
        isHistorical: false,
        status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      },
      orderBy: { date: "asc" },
      select: {
        id: true,
        date: true,
        status: true,
        maxPlayers: true,
        activity: { select: { name: true } },
      },
    });
    const picked = selectRegistrationMatch(candidates);
    if (!picked) continue;

    if (!best || picked.date < best.date) {
      best = {
        date: picked.date,
        matchId: picked.id,
        orgId: mem.orgId,
        clubName: mem.org.name,
        matchName: picked.activity.name,
        matchWhen: dayCommaTimeLabel(features.language, picked.date),
        maxPlayers: picked.maxPlayers,
        lang: features.language,
      };
    }
  }

  if (!best) return null;
  const { date: _date, ...target } = best;
  void _date;
  return target;
}
