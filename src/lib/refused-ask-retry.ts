/**
 * "TRY AGAIN" AFTER A REFUSAL (2026-10-28, Kemal; MT Test 15:38 to 15:40
 * UTC). An organiser asked "@Match Time ask the player pool and partner
 * clubs for extra players", MatchTime said it could not yet, he fixed the
 * venue on the web and said "@Match Time added the venue location". The
 * admin extractor read `other` and he got "I can't change that by message".
 *
 * Now the admin extractor reads `retry_ask`, and code repeats the ask. WHICH
 * ask is never read from text, MatchTime's or anyone's: it is the
 * organisers' last ask for players as it was STORED, its extractor facts.
 *
 *   the store        `LatestAskForRetry`, an interface. The branch
 *                    feat/retry-refused-ask adds stored refused asks; when
 *                    it lands, its reader is injected here and replaces the
 *                    interim one below (one line in each caller's deps).
 *   interim reader   `latestAskFromRecords`: the newest message in the
 *                    window whose stored pipeline trace (`pipelineTrace`, on
 *                    `AnalyzedMessage` for the players' group and
 *                    `AdminGroupMessage` for HQ) holds admin recruit facts.
 *                    It cannot tell an ask that was refused from one that
 *                    went out, and need not: the doors it goes back through
 *                    refuse a repeat themselves (one open partner ask per
 *                    pair, one open pool round per match) and say so.
 *
 * WHAT IS REPEATED: only the partner clubs and the MatchTime player pool
 * (`retryFactsOf`). Those are the asks MatchTime refuses for something an
 * organiser can fix (the venue, the pool switched off, a partner not set
 * up). A DM to the club's own players is never sent again by a "try
 * again": a repeated mass DM is the one mistake this product cannot take
 * back. Nothing to repeat: the caller says so in one short line.
 */
import type { AdminFacts } from "./pipeline/types";

/** How long after an ask "try again" still means it. */
export const RETRY_WINDOW_MS = 6 * 60 * 60 * 1000;

/** How soon after the ask a TAGGED message the router sent elsewhere is
 *  still read as a possible "try again" (`group-admin-followups.ts`, HQ). */
export const RETRY_FOLLOWUP_MS = 15 * 60_000;

export interface StoredAsk {
  /** The ask's admin extractor facts, as stored. */
  facts: AdminFacts;
  /** When it was asked. */
  at: Date;
}

/** Where the ask was made: the players' group, or the organisers' group. */
export type AskPlace = "group" | "hq";

export type LatestAskForRetry = (a: { orgId: string; where: AskPlace; now: Date }) => Promise<StoredAsk | null>;

/** The facts to act on again, or null when there is nothing to repeat. */
export function retryFactsOf(ask: StoredAsk | null, now: Date): AdminFacts | null {
  if (!ask || ask.facts.kind !== "admin" || ask.facts.action !== "recruit") return null;
  if (now.getTime() - ask.at.getTime() > RETRY_WINDOW_MS) return null;
  const f = ask.facts;
  if (!f.partnerClubs && !f.pool) return null;
  return {
    kind: "admin",
    action: "recruit",
    ...(f.partnerClubs ? { partnerClubs: true } : {}),
    ...(f.partnerClubs && f.clubRef ? { clubRef: f.clubRef } : {}),
    ...(f.pool ? { pool: true as const } : {}),
    toMatchTime: true,
  };
}

/** The admin extractor's facts off a stored pipeline trace, or null. */
export function adminFactsInTrace(trace: unknown): AdminFacts | null {
  const list = (trace as { extractions?: unknown } | null | undefined)?.extractions;
  if (!Array.isArray(list)) return null;
  for (const x of list) {
    const e = x as { extractor?: unknown; facts?: unknown } | null;
    const f = e?.facts as { kind?: unknown; action?: unknown } | null | undefined;
    if (e?.extractor === "admin" && f && typeof f === "object" && f.kind === "admin" && typeof f.action === "string") return f as AdminFacts;
  }
  return null;
}

/** The interim reader (see the header). Read-only. */
export const latestAskFromRecords: LatestAskForRetry = async ({ orgId, where, now }) => {
  const { db } = await import("./db");
  const since = new Date(now.getTime() - RETRY_WINDOW_MS);
  const rows =
    where === "hq"
      ? await db.adminGroupMessage.findMany({
          where: { orgId, fromMatchTime: false, createdAt: { gte: since, lte: now } },
          orderBy: { createdAt: "desc" },
          take: 40,
          select: { pipelineTrace: true, createdAt: true },
        })
      : await db.analyzedMessage.findMany({
          where: { orgId, createdAt: { gte: since, lte: now } },
          orderBy: { createdAt: "desc" },
          take: 40,
          select: { pipelineTrace: true, createdAt: true },
        });
  for (const r of rows ?? []) {
    const facts = adminFactsInTrace(r.pipelineTrace);
    if (facts?.action === "recruit" && (facts.partnerClubs || facts.pool)) return { facts, at: r.createdAt };
  }
  return null;
};
