/**
 * A ROUND OF PARTNER ASKS, HOW FULL IT IS (partner discovery P4,
 * 2026-10-22). Plan: MDs/partner-discovery-plan-2026-10-21.md, section 4.
 *
 * Asks sent together share a `roundId`, and the number they carry
 * (`places`, the organiser's choice) is for the WHOLE round, not each
 * partner: asking three clubs for 1 player is 1 player in total. The round
 * is filled when the guests who have a place (a CONFIRMED row on the
 * asking club's match) from any of its asks reach that number.
 *
 * Read only. Shared by `partner-ask.ts` (the sweep, an approval, the
 * panel) and `partner-guest.ts` (a first-come volunteer, under the match's
 * lock), so both count exactly the same way.
 *
 * THE POOL (local player pool L5a, 2026-10-24): a round may also carry a
 * pool ask (same `roundId`, or the pool ask's own id for a pool-only
 * round). Its number joins the round's and the pool guests who accepted
 * count as placed, read through `pool/round-share.ts` (pool tables are the
 * pool's). One definition of "filled" for partners and the pool alike.
 */
import { db } from "./db";
import { poolRoundShare } from "./pool/round-share";

export interface RoundAskRow {
  id: string;
  roundId: string | null;
  matchId: string;
  places: number;
  volunteerUserIds: string[];
  pickedUserIds: string[];
}

export interface RoundFill {
  /** The number the round asked for. */
  wanted: number;
  /** Its guests with a place now, from any of its asks. */
  placed: number;
}

/** How full is this ask's round now? An ask with no `roundId` is a round
 *  of its own. Reads the round's asks fresh, so a volunteer on another of
 *  its asks counts. */
export async function loadRoundFill(ask: RoundAskRow): Promise<RoundFill> {
  const asks = ask.roundId
    ? await db.partnerAsk.findMany({
        where: { matchId: ask.matchId, roundId: ask.roundId },
        select: { places: true, volunteerUserIds: true, pickedUserIds: true },
      })
    : [ask];
  const rows = asks.length > 0 ? asks : [ask];
  const pool = await poolRoundShare(ask.matchId, ask.roundId ?? ask.id);
  const wanted = Math.max(...rows.map((a) => a.places), pool?.places ?? 0);
  const ids = [...new Set([...rows.flatMap((a) => [...(a.volunteerUserIds ?? []), ...(a.pickedUserIds ?? [])]), ...(pool?.userIds ?? [])])];
  const placed = ids.length === 0 ? 0 : await db.attendance.count({ where: { matchId: ask.matchId, status: "CONFIRMED", userId: { in: ids } } });
  return { wanted, placed };
}
