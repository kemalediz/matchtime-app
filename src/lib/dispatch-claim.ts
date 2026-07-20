/**
 * Claim-on-dispatch — the guard against duplicate outbound WhatsApp sends.
 *
 * ── Why this exists ────────────────────────────────────────────────────
 * 2026-07-19 incident: a WhatsApp group received 30+ copies of the same
 * roster message in ~20 minutes. Root cause was duplicate bot processes on
 * the Raspberry Pi (repeated `systemctl restart` left processes running
 * outside systemd's cgroup, so instances accumulated). All of them were
 * logged into the same WhatsApp account and all polled
 * /api/whatsapp/due-posts every 30s.
 *
 * The server-side defect that turned "N processes" into "N messages" was
 * the placement of the idempotency write. The dedupe key was written only
 * on ACK — i.e. AFTER the bot had composed the text (LLM call) and sent it
 * over WhatsApp. That left a multi-second window in which every other
 * poller received the SAME instruction and sent it too. They then all
 * ACKed the same key, which upserted into exactly ONE SentNotification
 * row: 30+ messages in the group, one row in the database, nothing
 * obviously wrong server-side.
 *
 * The fix is to move the write to the front: an instruction is CLAIMED
 * (its SentNotification row created) at the moment it is handed to a bot,
 * relying on the existing `@unique` constraint on SentNotification.key so
 * the first writer wins and every concurrent claimant loses the race and
 * skips the instruction. ACK then becomes an idempotent update that
 * stamps waMessageId and runs the existing per-key-class side effects.
 *
 * ── ACCEPTED TRADE-OFF: delivery becomes AT-MOST-ONCE ─────────────────
 * If a bot claims an instruction and then dies (or the send fails) before
 * the message actually goes out, that message is LOST — nothing will
 * re-emit it, because the key is already taken. That is deliberate. For
 * this product a missed roster post is dramatically better than 30
 * duplicates in a customer's group chat, and the next cycle's post (the
 * evening update, the pre-kickoff chase, the next day's key) covers the
 * gap. We are explicitly choosing "occasionally silent" over "capable of
 * flooding".
 *
 * The one case where at-most-once was NOT acceptable is the bot's own DM
 * rate limiter, which deliberately holds a DM back and relies on the
 * server re-emitting it next tick. Those held DMs are RELEASED (the claim
 * row is deleted) via /api/whatsapp/ack with `release: true`, so they are
 * re-emitted normally. See whatsapp-bot/src/scheduler.ts.
 *
 * Everything in this file is pure — no DB, no network — so the race is
 * unit-testable. The actual atomic write is injected by the caller.
 */

// ─────────────────────────── Circuit breaker ──────────────────────────

/**
 * Hard cap on outbound GROUP messages per org per rolling hour.
 *
 * Legitimate MatchTime traffic is ~1-2 group posts per day per org (an
 * evening update, a pre-kickoff chase). 10/hour is an order of magnitude
 * above anything real, so this can only ever fire on a runaway. It is a
 * backstop for whatever the NEXT unforeseen duplication mechanism turns
 * out to be — the claim above is the actual fix.
 */
export const MAX_GROUP_MESSAGES_PER_HOUR = 10;

/** Rolling window the cap is measured over. */
export const CIRCUIT_BREAKER_WINDOW_MS = 60 * 60 * 1000;

/**
 * Instruction kinds that put a message in the GROUP chat (the thing that
 * flooded). DMs and reaction updates are paced/limited separately and
 * don't consume this budget.
 */
export const GROUP_DIRECTED_KINDS: ReadonlySet<string> = new Set([
  "group-message",
  "group-poll",
  "bench-prompt",
]);

export function isGroupDirected(kind: string): boolean {
  return GROUP_DIRECTED_KINDS.has(kind);
}

export interface BreakerVerdict {
  allowed: boolean;
  count: number;
  cap: number;
}

/** Pure predicate: given how many group posts already went out in the
 *  window, may we send another? */
export function evaluateCircuitBreaker(input: {
  recentGroupSends: number;
  cap?: number;
}): BreakerVerdict {
  const cap = input.cap ?? MAX_GROUP_MESSAGES_PER_HOUR;
  return {
    allowed: input.recentGroupSends < cap,
    count: input.recentGroupSends,
    cap,
  };
}

// ───────────────────────────── Claiming ───────────────────────────────

export type ClaimOutcome = "claimed" | "already-claimed" | "error";

/** Prisma's unique-constraint violation. A losing claimant sees exactly
 *  this and must NOT dispatch the instruction. */
export function classifyClaimError(err: unknown): Exclude<ClaimOutcome, "claimed"> {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "P2002" ? "already-claimed" : "error";
}

/** Minimal shape the claim path needs from a DueInstruction. */
export interface Claimable {
  kind: string;
  key: string;
  matchId?: string;
  targetUser?: string;
}

export interface SelectDispatchableResult<T extends Claimable> {
  /** Instructions this caller won the claim for — and only these get sent. */
  dispatch: T[];
  /** Keys another process claimed first (the duplicate we just prevented). */
  alreadyClaimed: string[];
  /** Keys whose claim write failed for some other reason — not dispatched. */
  errored: string[];
  breakerTripped: boolean;
}

/**
 * Filter a computed instruction list down to the ones this caller has
 * atomically claimed, respecting the per-org group-message circuit
 * breaker.
 *
 * `claim` must be a genuinely atomic write (Prisma `create` on the
 * `@unique` key, or `createMany({ skipDuplicates: true })`) that THROWS a
 * P2002 when the key is taken. A read-then-write "does this key exist?"
 * check would reintroduce exactly the race this fixes.
 */
export async function selectDispatchable<T extends Claimable>(
  instructions: T[],
  opts: {
    claim: (instr: T) => Promise<void>;
    /** Group posts already sent by this org inside the breaker window. */
    recentGroupSends: number;
    cap?: number;
    onBreak?: (info: BreakerVerdict) => void;
  },
): Promise<SelectDispatchableResult<T>> {
  const dispatch: T[] = [];
  const alreadyClaimed: string[] = [];
  const errored: string[] = [];
  let groupSends = opts.recentGroupSends;
  let breakerTripped = false;

  for (const instr of instructions) {
    if (isGroupDirected(instr.kind)) {
      const verdict = evaluateCircuitBreaker({ recentGroupSends: groupSends, cap: opts.cap });
      if (!verdict.allowed) {
        // Do NOT claim — leave the key free so a human can investigate
        // and the message can still go out once the breaker resets.
        if (!breakerTripped) opts.onBreak?.(verdict);
        breakerTripped = true;
        continue;
      }
    }

    try {
      await opts.claim(instr);
      if (isGroupDirected(instr.kind)) groupSends += 1;
      dispatch.push(instr);
    } catch (err) {
      const outcome = classifyClaimError(err);
      if (outcome === "already-claimed") alreadyClaimed.push(instr.key);
      else errored.push(instr.key);
    }
  }

  return { dispatch, alreadyClaimed, errored, breakerTripped };
}

// ──────────────────────── ACK side-effect plan ────────────────────────

export type AckSideEffect =
  | { type: "botjob-sent"; botJobId: string }
  | { type: "offer-wa-message-id"; offerId: string }
  | { type: "retro-reaction-sent"; retroReactionId: string }
  | { type: "tentative-followup-notified"; matchId: string; userId: string };

/**
 * Derive the per-key-class side effects an ACK must perform. Extracted
 * from the ack route purely so the mapping is unit-testable; the route
 * still owns the DB writes (and still applies the offer stamp only when a
 * waMessageId was actually reported).
 *
 * These must match the pre-existing behaviour exactly — every key class
 * that had a side effect before claim-on-dispatch still has it.
 */
export function planAckSideEffects(key: string): AckSideEffect[] {
  const effects: AckSideEffect[] = [];

  // `offer-<benchSlotOfferId>` is the GROUP offer post; a 👍 reaction is
  // resolved via BenchSlotOffer.waMessageId. The per-bencher DM key
  // `offer-<id>:dm:<userId>` is not an offer post — skip those.
  if (key.startsWith("offer-") && !key.includes(":dm:")) {
    effects.push({ type: "offer-wa-message-id", offerId: key.slice("offer-".length) });
  }

  if (key.startsWith("botjob-")) {
    effects.push({ type: "botjob-sent", botJobId: key.slice("botjob-".length) });
  }

  if (key.startsWith("retro-react-")) {
    effects.push({
      type: "retro-reaction-sent",
      retroReactionId: key.slice("retro-react-".length),
    });
  }

  if (key.includes(":tentative-followup:")) {
    const [matchId, , userId] = key.split(":");
    if (matchId && userId) {
      effects.push({ type: "tentative-followup-notified", matchId, userId });
    }
  }

  return effects;
}
