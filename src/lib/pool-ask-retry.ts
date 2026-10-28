/**
 * A REFUSED POOL ASK, ASKED AGAIN ON ITS OWN ONCE THE VENUE IS SET (Kemal,
 * 2026-10-28). The rules are `pool/ask-retry-rules.ts`, the store
 * `pool/ask-retry.ts`. Outside `src/lib/pool/` for the same reason as
 * `pool-ask-words.ts`, whose door it calls.
 *
 *   1. An organiser asks the pool in words (HQ, or the players' group) and
 *      `askPoolFromWords` is refused "no-venue": it calls
 *      `rememberRefusedPoolAsk` (any other refusal is never stored).
 *   2. A place gets linked to the game's venue, or the club's venue is
 *      set: every writer in `venue-location.ts` calls
 *      `afterVenueSet(orgId)`, which runs `retryAsksAwaitingVenue` after
 *      the save has answered. The WhatsApp venue setter calls
 *      `retryAsksAwaitingVenue(orgId)` too.
 *   3. Each stored ask that still makes sense (`askRetryDecision`) is
 *      claimed once (compare-and-set), asked again through the very same
 *      door (`askPoolFromWords`, every rule of the first ask re-checked,
 *      the organiser's role included), and the reply is posted in the
 *      group it was asked in, under one line saying why it happens now.
 *      A second refusal is posted with its reason; nothing more is stored.
 *
 * The post is queued as a `BotJob` (the admin group's or the players'
 * group's), so a muted club sends nothing until unmuted, and the admin
 * group's own posting hours apply. It is a plain post: the Pi does not
 * quote a scheduled message yet (`askMessageId` is kept for when it does).
 *
 * NEVER FAILS ITS CALLER. Every error is caught and logged (ids only): a
 * venue save, or the ask's own reply, is never affected.
 */
import { db } from "./db";
import { venueSetRetryText } from "./i18n/pool-ask-retry";
import { askPoolFromWords } from "./pool-ask-words";
import { askRetryDecision, type AskRetryRefusal } from "./pool/ask-retry-rules";
import {
  askRetriesAwaiting,
  claimAskRetry,
  dropAskRetry,
  loadAskRetryFacts,
  recordAskRetryOutcome,
  rememberRefusedAsk,
  type AskRetryPlace,
} from "./pool/ask-retry";

type Env = Record<string, string | undefined>;

/** Step 1: called by `askPoolFromWords` when an ask in words is refused. */
export async function rememberRefusedPoolAsk(a: {
  orgId: string;
  matchId: string;
  askedByUserId: string;
  askedIn: AskRetryPlace;
  askMessageId: string | null;
  places: number;
  refusal: string;
  now: Date;
}): Promise<void> {
  try {
    const id = await rememberRefusedAsk(a);
    if (id) console.log(`[ask-retry] ${a.orgId}: refused ask for match ${a.matchId} (${a.refusal}) kept as ${id}`);
  } catch (err) {
    console.error(`[ask-retry] ${a.orgId}: could not keep the refused ask:`, err instanceof Error ? err.message : "failed");
  }
}

export interface AskRetryOutcome {
  id: string;
  matchId: string;
  /** "asked" or "refused": posted. "wait": kept. "drop:<reason>": closed silently. "lost": another caller won the claim. */
  result: "asked" | "refused" | "wait" | "lost" | `drop:${string}`;
}

async function resolveEnv(env: Env | undefined): Promise<Env> {
  if (env) return env;
  const { resolvePoolEnv } = await import("./pool/switch-env");
  return resolvePoolEnv(undefined);
}

async function retryAsksAwaiting(orgId: string, refusals: readonly AskRetryRefusal[], opts: { now?: Date; env?: Env }): Promise<AskRetryOutcome[]> {
  const now = opts.now ?? new Date();
  const out: AskRetryOutcome[] = [];
  try {
    const rows = await askRetriesAwaiting(orgId, refusals, now);
    if (rows.length === 0) return out;
    const env = await resolveEnv(opts.env);
    const org = await db.organisation.findUnique({ where: { id: orgId }, select: { language: true } });
    for (const row of rows) {
      try {
        const facts = await loadAskRetryFacts(row, now, env);
        const decision = facts ? askRetryDecision(row, facts) : ({ kind: "drop", reason: "match-off" } as const);
        if (decision.kind === "wait") {
          out.push({ id: row.id, matchId: row.matchId, result: "wait" });
          continue;
        }
        if (decision.kind === "drop") {
          if (await dropAskRetry(row.id, decision.reason, now)) console.log(`[ask-retry] ${orgId}: ${row.id} dropped (${decision.reason})`);
          out.push({ id: row.id, matchId: row.matchId, result: `drop:${decision.reason}` });
          continue;
        }
        if (!(await claimAskRetry(row.id, now))) {
          out.push({ id: row.id, matchId: row.matchId, result: "lost" });
          continue;
        }
        const r = await askPoolFromWords({
          orgId,
          matchId: row.matchId,
          userId: row.askedByUserId,
          via: "words",
          where: row.askedIn,
          lang: org?.language ?? null,
          now,
          env,
        });
        const asked = r.outcome === "hq-pool-asked";
        const text = venueSetRetryText(org?.language ?? null, { asked, replyText: r.replyText });
        await db.botJob.create({ data: { orgId, kind: row.askedIn === "hq" ? "admin-group" : "group", text, matchId: row.matchId } });
        await recordAskRetryOutcome(row.id, r.outcome);
        console.log(`[ask-retry] ${orgId}: ${row.id} asked again for match ${row.matchId} in ${row.askedIn}: ${r.outcome}`);
        out.push({ id: row.id, matchId: row.matchId, result: asked ? "asked" : "refused" });
      } catch (err) {
        console.error(`[ask-retry] ${orgId}: ${row.id} failed:`, err instanceof Error ? err.message : "failed");
      }
    }
  } catch (err) {
    console.error(`[ask-retry] ${orgId}: retry failed:`, err instanceof Error ? err.message : "failed");
  }
  return out;
}

/**
 * Step 3, for the venue: ask again every refused "no-venue" ask of the
 * club that still makes sense. Safe to call after any venue write, as
 * often as it happens: an ask whose venue is still missing waits, and each
 * stored ask is asked again once at most. `env`: the pool switch as the
 * caller resolved it; absent, the platform switch is read now.
 */
export function retryAsksAwaitingVenue(orgId: string, opts: { now?: Date; env?: Env } = {}): Promise<AskRetryOutcome[]> {
  return retryAsksAwaiting(orgId, ["no-venue"], opts);
}

/**
 * Step 2: after a venue write, from inside the request that made it. The
 * pool switch is read from that request (its test seam included) now,
 * and the retry runs once the response has been sent (`after`), so the
 * save never waits for it. Outside a request it simply runs.
 */
export async function afterVenueSet(orgId: string): Promise<void> {
  let env: Env | undefined;
  try {
    const { poolEnvForRequest } = await import("./pool/switch-env");
    env = await poolEnvForRequest();
  } catch {
    env = undefined;
  }
  const run = () => retryAsksAwaitingVenue(orgId, { env }).then(() => undefined);
  try {
    const { after } = await import("next/server");
    after(run);
  } catch {
    await run();
  }
}
