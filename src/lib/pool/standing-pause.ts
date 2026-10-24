/**
 * A PAUSE MATCHTIME DECIDED COMES BACK ON A NEW PROFILE (slice L7; review of
 * #404, finding 4). Deleting a pool profile erases its pause, but his guest
 * places and the clubs' reports about him survive (no foreign key on the
 * reports; places stay with the clubs). So whenever a profile turns active
 * (the WhatsApp confirm, a member's yes to a claim, a member joining from
 * his profile), the rules are run again on those records
 * (`reliability-rules.ts` `standingPause`) in the activation's own
 * transaction, and he comes back paused when they still apply. No message:
 * his manage page says why. A no-show pause keeps its original date, so
 * re-joining neither restarts nor shortens the 30 days.
 */
import { standingPause } from "./reliability-rules";
import { isOneOf, GUEST_RESULTS, type GuestResult } from "./vocab";

export interface StandingPauseClient {
  guestPlace: { findMany(args: unknown): Promise<unknown[]> };
  poolReport: { findMany(args: unknown): Promise<unknown[]> };
  poolProfile: { updateMany(args: unknown): Promise<{ count: number }> };
}

type PlaceRow = { result: string; settledAt: Date | null; match: { date: Date; status: string } };

export async function applyStandingPause(client: StandingPauseClient, userId: string, now: Date): Promise<"no-shows" | "reports" | null> {
  const [places, reports] = (await Promise.all([
    client.guestPlace.findMany({ where: { userId }, select: { result: true, settledAt: true, match: { select: { date: true, status: true } } } }),
    client.poolReport.findMany({ where: { userId, by: "club", reviewedAt: null }, select: { orgId: true } }),
  ])) as [PlaceRow[], { orgId: string }[]];
  const pause = standingPause({
    games: places.map((p) => ({
      kickoff: p.match.date,
      result: (isOneOf(GUEST_RESULTS, p.result) ? p.result : "booked") as GuestResult,
      settledAt: p.settledAt,
      cancelled: p.match.status === "CANCELLED",
    })),
    openClubReportOrgs: reports.map((r) => r.orgId),
    now,
  });
  if (!pause) return null;
  const done = await client.poolProfile.updateMany({
    where: { userId, status: "active" },
    data: { status: "paused", pausedReason: pause.reason, pausedAt: pause.pausedAt },
  });
  if (done.count > 0) console.log(`[pool] ${userId}: a new profile comes back paused (${pause.reason})`);
  return done.count > 0 ? pause.reason : null;
}
