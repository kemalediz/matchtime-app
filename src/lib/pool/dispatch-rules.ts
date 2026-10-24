/**
 * ADMITTING POOL OFFERS AT DISPATCH (slice L5a, 2026-10-24). PURE.
 *
 * L4's design (`caps.ts` header) implemented: the platform caps are
 * enforced when an offer's platform job is CLAIMED, not when a round is
 * planned. The I/O half (`dispatch.ts`) takes
 * `pg_advisory_xact_lock(hashtext('pool-platform-cap'))`, reads the state
 * below, calls `planPoolAdmission` and applies it in the same
 * transaction, so no two claimers can spend the same room.
 *
 * For each queued `pool-offer` job, oldest first:
 *   cancel  the global switch or the club's flag is off; he is no longer
 *           active (paused, stopped); the offer was answered or ended, or
 *           its round closed; or one of HIS caps refuses it now (another
 *           club's offer to him went out meanwhile). Never sent; the offer
 *           ends `cancelled` (it never reached him, so no cap counts it).
 *   defer   quiet hours (21:30 to 08:30 London): held to 08:30, never
 *           dropped. One admitted earlier and released by the Pi's
 *           pacing is un-admitted, so it is counted again at 08:30.
 *   admit   stamp `sentAt` now, within the room the platform caps leave
 *           and the per-poll limit.
 *   hold    no room now: left queued for a later poll.
 * One admitted before (released by the Pi) passes again without room.
 */
import { platformRoom, playerCapRefusal, type OfferLedgerEntry, type PlayerCapRefusal } from "./caps";
import { poolSendAt } from "./waves";

export interface PoolJobView {
  jobId: string;
  offerId: string;
  userId: string;
  orgId: string;
  /** `PoolOffer.sentAt` is set: admitted by an earlier poll. */
  admitted: boolean;
  /** The global switch AND the club's flag. */
  clubOpen: boolean;
  profileActive: boolean;
  /** The offer has no outcome. */
  offerOpen: boolean;
  /** Its ask is still open. */
  askOpen: boolean;
  /** His OTHER offers, for his caps. */
  ledger: OfferLedgerEntry[];
}

export type AdmissionCancelReason = "switched-off" | "profile-off" | "closed" | PlayerCapRefusal;

export interface PoolAdmission {
  admit: string[];
  hold: string[];
  cancel: Array<{ jobId: string; offerId: string; reason: AdmissionCancelReason }>;
  defer: Array<{ jobId: string; offerId: string; until: Date; unadmit: boolean }>;
}

export function planPoolAdmission(jobs: readonly PoolJobView[], sentAts: readonly Date[], now: Date, limit: number): PoolAdmission {
  const plan: PoolAdmission = { admit: [], hold: [], cancel: [], defer: [] };
  const quietUntil = poolSendAt(now);
  const quiet = quietUntil.getTime() > now.getTime();
  let room = platformRoom(sentAts, now);
  /** Offers admitted in THIS poll, per person, so his caps see them. */
  const admittedNow = new Map<string, OfferLedgerEntry[]>();

  for (const j of jobs) {
    const cancel = (reason: AdmissionCancelReason) => plan.cancel.push({ jobId: j.jobId, offerId: j.offerId, reason });
    if (!j.clubOpen) {
      cancel("switched-off");
      continue;
    }
    if (!j.profileActive) {
      cancel("profile-off");
      continue;
    }
    if (!j.offerOpen || !j.askOpen) {
      cancel("closed");
      continue;
    }
    if (quiet) {
      plan.defer.push({ jobId: j.jobId, offerId: j.offerId, until: quietUntil, unadmit: j.admitted });
      continue;
    }
    if (j.admitted) {
      plan.admit.push(j.jobId);
      continue;
    }
    const ledger = [...j.ledger, ...(admittedNow.get(j.userId) ?? [])];
    const refusal = playerCapRefusal(ledger, j.orgId, now);
    if (refusal) {
      cancel(refusal);
      continue;
    }
    if (room <= 0 || plan.admit.length >= limit) {
      plan.hold.push(j.jobId);
      continue;
    }
    plan.admit.push(j.jobId);
    room--;
    admittedNow.set(j.userId, [...(admittedNow.get(j.userId) ?? []), { orgId: j.orgId, at: now, outcome: null, resolvedAt: null }]);
  }
  return plan;
}
