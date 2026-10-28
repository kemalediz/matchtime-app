/**
 * THE STORE OF REFUSED POOL ASKS WAITING FOR A FIX (2026-10-28). Thin I/O
 * over `PoolAskRetry`; the rules are `ask-retry-rules.ts`, the retry itself
 * (asking again and posting) is `../pool-ask-retry.ts`.
 *
 * ONCE EVER. `claimAskRetry` is a compare-and-set on `claimedAt`: of two
 * venue saves at once, exactly one wins the row and asks; the other sees
 * nothing to do. A dropped row is closed the same way, so it is never
 * asked later either.
 *
 * One row per match and refusal: a newer refused ask for the same match
 * replaces the older one (its asker, its group, a fresh day), and opens it
 * again even if the older one was already retried.
 */
import { db } from "../db";
import { askWindows } from "../partner-ask-rules";
import { loadPartnerAskSettings } from "../club-partnership";
import { PARTNER_ASK_CUTOFF_DEFAULT_HOURS } from "../club-partnership-rules";
import { ASK_RETRY_MAX_AGE_MS, isRetryableRefusal, type AskRetryFacts, type AskRetryRefusal } from "./ask-retry-rules";
import { findPoolCandidates } from "./candidates";
import { OPEN_MATCH_STATUSES } from "./matching-rules";
import { poolOffersOpenForClub, poolSwitchUnread } from "./flags";
import { placesOpenOf } from "./round";

type Env = Record<string, string | undefined>;

export type AskRetryPlace = "hq" | "group";

export interface StoredAskRetry {
  id: string;
  orgId: string;
  matchId: string;
  askedByUserId: string;
  askedIn: AskRetryPlace;
  askMessageId: string | null;
  places: number;
  refusal: string;
  claimedAt: Date | null;
  createdAt: Date;
}

/**
 * Remember a refused ask, if a club setting can fix its refusal. Every
 * other refusal is never stored. Returns the row's id, or null.
 */
export async function rememberRefusedAsk(a: {
  orgId: string;
  matchId: string;
  askedByUserId: string;
  askedIn: AskRetryPlace;
  askMessageId: string | null;
  places: number;
  refusal: string;
  now: Date;
}): Promise<string | null> {
  if (!isRetryableRefusal(a.refusal)) return null;
  const fields = {
    orgId: a.orgId,
    askedByUserId: a.askedByUserId,
    askedIn: a.askedIn,
    askMessageId: a.askMessageId,
    places: a.places,
    claimedAt: null,
    outcome: null,
    createdAt: a.now,
  };
  const row = await db.poolAskRetry.upsert({
    where: { matchId_refusal: { matchId: a.matchId, refusal: a.refusal } },
    create: { matchId: a.matchId, refusal: a.refusal, ...fields },
    update: fields,
    select: { id: true },
  });
  return row.id;
}

/** The club's unclaimed refused asks for these refusals, from the last day. */
export async function askRetriesAwaiting(orgId: string, refusals: readonly AskRetryRefusal[], now: Date): Promise<StoredAskRetry[]> {
  const rows = await db.poolAskRetry.findMany({
    where: { orgId, claimedAt: null, refusal: { in: [...refusals] }, createdAt: { gt: new Date(now.getTime() - ASK_RETRY_MAX_AGE_MS) } },
    orderBy: { createdAt: "asc" },
    select: { id: true, orgId: true, matchId: true, askedByUserId: true, askedIn: true, askMessageId: true, places: true, refusal: true, claimedAt: true, createdAt: true },
  });
  return (rows ?? []).map((r) => ({ ...r, askedIn: r.askedIn === "hq" ? "hq" : "group" }));
}

/** The once-ever claim. True for exactly one caller. */
export async function claimAskRetry(id: string, now: Date): Promise<boolean> {
  const { count } = await db.poolAskRetry.updateMany({ where: { id, claimedAt: null }, data: { claimedAt: now } });
  return count === 1;
}

/** What the claimed retry came to. */
export async function recordAskRetryOutcome(id: string, outcome: string): Promise<void> {
  await db.poolAskRetry.updateMany({ where: { id }, data: { outcome } });
}

/** Close a row that no longer makes sense, so it is never asked. */
export async function dropAskRetry(id: string, reason: string, now: Date): Promise<boolean> {
  const { count } = await db.poolAskRetry.updateMany({ where: { id, claimedAt: null }, data: { claimedAt: now, outcome: `drop:${reason}` } });
  return count === 1;
}

/** Everything `askRetryDecision` needs about the row's match, now. Null: the match is gone. */
export async function loadAskRetryFacts(row: StoredAskRetry, now: Date, env: Env): Promise<AskRetryFacts | null> {
  const match = await db.match.findUnique({
    where: { id: row.matchId },
    select: { date: true, status: true, isHistorical: true, activity: { select: { orgId: true, org: { select: { featurePlayerPool: true } } } } },
  });
  if (!match || match.activity.orgId !== row.orgId) return null;
  const [settings, placesOpen, askedSince, found] = await Promise.all([
    loadPartnerAskSettings(row.orgId),
    placesOpenOf(row.matchId),
    db.poolAsk.count({ where: { matchId: row.matchId, orgId: row.orgId, createdAt: { gt: row.createdAt } } }),
    findPoolCandidates(row.matchId, { now, env }),
  ]);
  const cutoff = askWindows(match.date, settings?.cutoffHours ?? PARTNER_ASK_CUTOFF_DEFAULT_HOURS).postBy;
  const open = poolOffersOpenForClub(match.activity.org, env);
  return {
    now,
    kickoff: match.date,
    cutoff,
    matchOpen: !match.isHistorical && (OPEN_MATCH_STATUSES as readonly string[]).includes(match.status),
    placesOpen,
    poolOpen: open ? true : poolSwitchUnread(env) ? null : false,
    askedSince: askedSince > 0,
    stillRefused: found.selection.gate === row.refusal,
  };
}
