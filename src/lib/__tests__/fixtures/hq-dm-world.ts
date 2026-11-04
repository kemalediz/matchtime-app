/**
 * A FAKE DATABASE FOR THE ADMIN GROUP'S AND THE DMs' CHARACTERISATION (club
 * summary, slice A3, MDs/club-summary-design-2026-11-04.md section 4.2).
 *
 * The analyze path's fake world (`analyze-world.ts`, slice A2) for one club
 * of the summary's fixtures, given what an admin group (HQ) message and a
 * DM need on top: every member with a real phone number (the HQ door and
 * the DM route find the sender by it), and the club's admin group linked.
 * Every table the fake does not hold answers empty; writes succeed, are
 * logged and change nothing, so every request sees the same world before
 * and after the slice.
 */
import type { ClubRows, MemberRow } from "../../club-summary/derive";
import { analyzeWorld, fakeAnalyzeDb, type AnalyzeWorld, type Call } from "./analyze-world";

/** A club's rows with its admin group linked and every member given a
 *  real number: `+4477009003NN`, NN by roster position. */
export function withHq(rows: ClubRows, opts: { linkHq?: boolean } = {}): ClubRows {
  const members = rows.members
    ? {
        ...rows.members,
        rows: rows.members.rows.map(
          (m, i): MemberRow => ({ ...m, user: { ...m.user, phoneNumber: `+4477009003${String(i + 10)}` } }),
        ),
      }
    : null;
  const linkHq = opts.linkHq ?? true;
  return {
    ...rows,
    org: linkHq
      ? { ...rows.org, adminGroupId: rows.org.adminGroupId ?? `hq-${rows.org.id}@g.us`, adminChannelMode: "admin-group" }
      : rows.org,
    members,
  };
}

/** The phone of a member of `withHq` rows, by user id. */
export function phoneOf(rows: ClubRows, userId: string): string {
  const m = rows.members?.rows.find((r) => r.user.id === userId);
  if (!m?.user.phoneNumber) throw new Error(`no member ${userId} with a phone in ${rows.org.id}`);
  return m.user.phoneNumber;
}

export interface HqDmWorld extends AnalyzeWorld {}

export function hqDmWorld(rows: ClubRows): HqDmWorld {
  const w = analyzeWorld(rows);
  // The admin group's own columns the HQ door reads off the club's row.
  w.org.featurePlayerPool = false;
  // The relations the DM route and the HQ door select through: a user's
  // memberships, a membership's club.
  for (const m of w.memberships) m.org = w.org;
  for (const u of w.users) u.memberships = w.memberships.filter((m) => m.userId === u.id).map((m) => ({ orgId: m.orgId, role: m.role }));
  // The team generator reads each player's positions through his user.
  const rowsWithUser = [...w.matches.flatMap((m) => m.attendances as Array<Record<string, unknown>>), ...(w.extra.attendance ?? [])];
  for (const a of rowsWithUser) a.user = { ...(a.user as Record<string, unknown>), activityPositions: [] };
  // The DM question's season stats read each played match's ratings.
  for (const m of w.matches) Object.assign(m, { ratings: [], momVotes: [] });
  return w;
}

/** The fake `db`, with the daily AI allowance's raw SQL answered as a club
 *  under its cap (one row, nothing spent): the DM classifiers' raw calls
 *  reserve from it before they ask (`ai-budget.ts`), and an empty answer
 *  reads as the cap reached. */
export function fakeHqDmDb(world: HqDmWorld, calls: Call[]) {
  const inner = fakeAnalyzeDb(world, calls) as Record<string, unknown>;
  return new Proxy(inner, {
    get(target, key: string) {
      if (key === "$queryRaw") return async () => [{ ok: 1, costUsd: 0, reservedUsd: 0 }];
      return target[key];
    },
  });
}

export type { Call };
