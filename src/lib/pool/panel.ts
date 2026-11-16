/**
 * THE POOL ON THE MATCH PAGE AND IN THE SHORT-SQUAD NOTICE (slice L5a,
 * 2026-10-24). What a club's organisers see of the pool, and nothing more
 * (plan section 6): before asking, a BAND ("a few", "5+"), never a name, a
 * number, an area or a list; once offers are out, how many were asked and
 * how many said no, never who.
 *
 *   loadPoolPanel     the match page's pool tick: null when the pool is not
 *                     open for this club (the switch or its flag), so the
 *                     page is exactly as before for every club today.
 *   poolNoticeBand    the band for the short-squad notice's extra line, or
 *                     null when there is nothing to offer (closed, no venue,
 *                     nobody near, an ask already open, past the cut-off).
 *
 * STAFF TESTS (rounds 3 and 4 of #607): a MatchTime staff test may be
 * offered the match, so the whole path can be tested, and whether the pool
 * can be asked counts him (so the button, the notice line and the HQ YES
 * list appear with only him near); but the band shown, asked, declined and
 * placed do not. Offers carry their own flag (`PoolOffer.staffTest`), so a
 * deleted staff-test profile stays out.
 */
import { db } from "../db";
import { loadPartnerAskSettings } from "../club-partnership";
import { PARTNER_ASK_CUTOFF_DEFAULT_HOURS } from "../club-partnership-rules";
import { askWindows } from "../partner-ask-rules";
import { findPoolCandidates, shownPoolBand } from "./candidates";
import { poolAskShownFill } from "./round";
import type { PoolNearBand } from "./near-band";
import type { MatchGateRefusal } from "./matching-rules";

type Env = Record<string, string | undefined>;

export interface PoolPanelData {
  band: PoolNearBand;
  /** Why the pool cannot be asked for this match, when it cannot. */
  gate: Exclude<MatchGateRefusal, "pool-closed"> | null;
  /** The pool's open (or last) ask for this match. */
  ask: { roundKey: string; status: string; asked: number; declined: number; wanted: number; placed: number } | null;
}

export async function loadPoolPanel(matchId: string, orgId: string, opts: { now?: Date; env?: Env } = {}): Promise<PoolPanelData | null> {
  const now = opts.now ?? new Date();
  const found = await findPoolCandidates(matchId, { now, env: opts.env });
  if (found.selection.gate === "pool-closed" || !found.ctx || found.ctx.orgId !== orgId) return null;
  const ask = await db.poolAsk.findFirst({
    where: { matchId, orgId },
    orderBy: { createdAt: "desc" },
    select: { id: true, roundId: true, status: true, places: true, offers: { select: { sentAt: true, outcome: true, staffTest: true } } },
  });
  const roundKey = ask ? (ask.roundId ?? ask.id) : null;
  // The round's SHOWN fill (`loadRoundFillShown`, shared with the partners'
  // panel): a staff test holding a place is not shown as found, so it never
  // reads "asked 0, placed 1". The real fill still counts him.
  const fill = ask ? await poolAskShownFill({ id: ask.id, roundId: ask.roundId, matchId, places: ask.places }) : null;
  // Staff tests are read off the offer's own flag, which outlives the profile.
  const counted = ask ? ask.offers.filter((o) => !o.staffTest) : [];
  return {
    // Asking is decided by everyone eligible, staff tests included; the
    // band shown counts real players only (`shownPoolBand`).
    band: shownPoolBand(found),
    gate: found.selection.gate,
    ask: ask
      ? {
          roundKey: roundKey!,
          status: ask.status,
          asked: counted.filter((o) => o.sentAt).length,
          declined: counted.filter((o) => o.outcome === "declined").length,
          wanted: fill?.wanted ?? ask.places,
          placed: fill?.placed ?? 0,
        }
      : null,
  };
}

export async function poolNoticeBand(orgId: string, match: { id: string; date: Date }, now: Date, env?: Env): Promise<PoolNearBand | null> {
  const settings = await loadPartnerAskSettings(orgId);
  if (now.getTime() >= askWindows(match.date, settings?.cutoffHours ?? PARTNER_ASK_CUTOFF_DEFAULT_HOURS).postBy.getTime()) return null;
  const panel = await loadPoolPanel(match.id, orgId, { now, env });
  if (!panel || panel.gate || panel.ask?.status === "open") return null;
  return panel.band === "none" ? null : panel.band;
}
