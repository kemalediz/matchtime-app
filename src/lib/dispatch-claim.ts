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

import { createHash } from "node:crypto";

// ──────────────────────── Outbound safety guards ──────────────────────
//
// There are TWO guards, and only one of them is really the protection.
//
// The original guard (2026-07-19, the day after the incident) was a raw
// volume cap: 10 group messages per org per hour. It was written in a
// hurry and it is the wrong shape. A volume cap gags the bot exactly
// when the group is at its busiest — match day, people dropping out,
// people asking questions — and every one of those replies is
// legitimate. Silently suppressing them is a worse product failure than
// the thing the cap was guarding against.
//
// The right observation is about the SHAPE of a runaway, not its volume:
//
//     a runaway sends MANY COPIES OF THE SAME MESSAGE.
//     a busy match day sends MANY DIFFERENT MESSAGES.
//
// So the real guard is a REPETITION guard: the same normalised text going
// to the same group more than a handful of times inside a few minutes is
// always a bug, and is never something a human wanted. Volume alone is
// not evidence of anything.
//
// The volume cap survives, raised to a level it should never reach, as a
// last-resort sanity ceiling for failure modes we have not imagined.

// ─────────────────── Guard 1: repetition (the real one) ───────────────

/**
 * How many times one identical group message may go out inside
 * REPETITION_WINDOW_MS before we refuse to send it again.
 *
 * Three is already generous. No legitimate MatchTime post is repeated
 * verbatim to the same group inside five minutes: every scheduler post
 * embeds the activity, date, venue or a specific player's name, and each
 * one is keyed so it can only ever be claimed once. Reaching four means
 * something is looping.
 */
export const MAX_IDENTICAL_GROUP_MESSAGES = 3;

/**
 * The window the repetition guard looks back over.
 *
 * Deliberately tight. Legitimately identical wording DOES recur — the
 * daily 17:00 attendance chase can read the same on two different days,
 * and an admin can reasonably re-post something an hour later. Those are
 * hours or days apart. Five minutes only ever contains repeats that a
 * machine produced: the bot polls every ~30s, so a runaway re-emitting
 * on every tick clears the limit inside two minutes, while a human
 * pressing "send" four times in five minutes is indistinguishable from
 * that runaway anyway (and is spam either way).
 */
export const REPETITION_WINDOW_MS = 5 * 60 * 1000;

// ──────────────────── Guard 2: volume sanity ceiling ──────────────────

/**
 * Last-resort ceiling on outbound GROUP messages per org per rolling
 * hour.
 *
 * Normal traffic is 1-2 group posts per day, but a chaotic match day
 * with a dozen drop-outs, questions and roster corrections can
 * legitimately produce a lot of DIFFERENT posts in one hour. 40 is far
 * above anything real and low enough to bound a catastrophe. It exists
 * only to catch a failure mode the repetition guard cannot see (many
 * different messages, all wrong). It should never fire; if it does, it
 * is an incident, not a tuning problem.
 */
export const MAX_GROUP_MESSAGES_PER_HOUR = 40;

/** Rolling window the ceiling is measured over. */
export const CIRCUIT_BREAKER_WINDOW_MS = 60 * 60 * 1000;

/**
 * Instruction kinds that put a message in the GROUP chat (the thing that
 * flooded). BOTH guards apply to these and to nothing else.
 *
 * DMs are deliberately and completely UNGATED. A player who says OUT or
 * asks a question must always get their reply, and identical DM text
 * across many players ("You're IN for Tuesday ✅") is entirely normal —
 * gating DMs on repetition would break the product on a busy day. DM
 * pacing is handled separately by the bot's own rate limiter.
 */
export const GROUP_DIRECTED_KINDS: ReadonlySet<string> = new Set([
  "group-message",
  "group-poll",
  "bench-prompt",
]);

export function isGroupDirected(kind: string): boolean {
  return GROUP_DIRECTED_KINDS.has(kind);
}

// ───────────────── Recording what we already sent (no migration) ──────
//
// The repetition guard needs "what group text has this org sent
// recently". Nothing stores that: SentNotification has `key` and `kind`
// but no body, and BotJob.text only covers ad-hoc admin jobs, not the
// scheduler-generated posts that make up most group traffic.
//
// Adding a column is not an option (a migration the night before a live
// customer match is not a trade we are making), and an in-process buffer
// is worthless here because the app runs on Vercel across many
// short-lived instances.
//
// So we HASH AND STORE, in the table we already write to. Every group
// post we dispatch also writes a tiny ledger row into SentNotification:
//
//     key  = txtlog:<orgId>:<hash>:<instructionKey>
//     kind = outbound-text-log
//
// No schema change, and it is inert to every existing reader:
//   - the scheduler's dedupe set only loads rows joined to this org's
//     matches or keyed `org-<id>:`, so it never even sees these;
//   - the hourly ceiling counts `kind IN GROUP_DIRECTED_KINDS`, and this
//     kind is deliberately not one of them;
//   - poll-vote matches on waMessageId, which is null here;
//   - planAckSideEffects has no branch for the `txtlog:` prefix.
// Including the instruction key makes the row unique, so N sends of one
// text produce N countable rows.

/** `kind` written on ledger rows. Never a real instruction kind. */
export const OUTBOUND_TEXT_LOG_KIND = "outbound-text-log";

const OUTBOUND_TEXT_LOG_PREFIX = "txtlog:";

/** Key prefix for one org's ledger rows — what the route filters on. */
export function outboundTextLogPrefix(orgId: string): string {
  return `${OUTBOUND_TEXT_LOG_PREFIX}${orgId}:`;
}

export function outboundTextLogKey(orgId: string, hash: string, instructionKey: string): string {
  return `${outboundTextLogPrefix(orgId)}${hash}:${instructionKey}`;
}

/** Inverse of {@link outboundTextLogKey}. Null for any real instruction key. */
export function parseOutboundTextLogKey(key: string): { orgId: string; hash: string } | null {
  if (!key.startsWith(OUTBOUND_TEXT_LOG_PREFIX)) return null;
  const rest = key.slice(OUTBOUND_TEXT_LOG_PREFIX.length);
  const [orgId, hash] = rest.split(":");
  if (!orgId || !hash) return null;
  return { orgId, hash };
}

/**
 * Canonical form used for comparison: trimmed, all whitespace runs
 * collapsed to a single space, lowercased.
 *
 * Lowercasing is deliberate. A runaway re-renders one template, so case
 * never varies between its copies — lowercasing therefore costs us
 * nothing in detection, and it buys us the near-duplicate case where two
 * copies differ only because a name or a keyword was cased differently
 * on the way through. Two GENUINELY different posts that differ from
 * each other by case alone, four times inside five minutes, do not
 * exist.
 */
export function normaliseOutboundText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Short, stable digest of the normalised text. Hex only, so it is safe
 *  to embed in a `:`-delimited ledger key. */
export function hashOutboundText(text: string): string {
  return createHash("sha256").update(normaliseOutboundText(text)).digest("hex").slice(0, 16);
}

/**
 * The comparable outbound body of an instruction, or null when there is
 * nothing to compare (a reaction, or an empty body).
 *
 * A poll's identity is its question AND its options: two polls asking
 * "MoM?" over different shortlists are different posts.
 */
export function outboundTextOf(instr: Claimable): string | null {
  const parts: string[] = [];
  if (typeof instr.question === "string" && instr.question.trim()) parts.push(instr.question);
  if (Array.isArray(instr.options) && instr.options.length) parts.push(instr.options.join("\n"));
  if (parts.length === 0 && typeof instr.text === "string") parts.push(instr.text);
  const joined = parts.join("\n");
  return normaliseOutboundText(joined) ? joined : null;
}

/** One previously-dispatched group post, as the guard sees it. */
export interface RecentOutboundText {
  hash: string;
  at: Date;
}

export interface RepetitionVerdict {
  allowed: boolean;
  /** Identical sends already inside the window. */
  repeats: number;
  limit: number;
  windowMs: number;
}

/**
 * Pure predicate: given what this group has already been sent, may we
 * send this exact text again?
 */
export function evaluateRepetition(input: {
  textHash: string;
  recent: readonly RecentOutboundText[];
  now: Date;
  limit?: number;
  windowMs?: number;
}): RepetitionVerdict {
  const limit = input.limit ?? MAX_IDENTICAL_GROUP_MESSAGES;
  const windowMs = input.windowMs ?? REPETITION_WINDOW_MS;
  const cutoff = input.now.getTime() - windowMs;
  let repeats = 0;
  for (const entry of input.recent) {
    if (entry.hash === input.textHash && entry.at.getTime() >= cutoff) repeats += 1;
  }
  return { allowed: repeats < limit, repeats, limit, windowMs };
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
  /** Message body, when the instruction carries one (group-message, dm,
   *  bench-prompt). Read by the repetition guard. */
  text?: string;
  /** Poll question / options — a poll's body for comparison purposes. */
  question?: string;
  options?: string[];
}

export interface SelectDispatchableResult<T extends Claimable> {
  /** Instructions this caller won the claim for — and only these get sent. */
  dispatch: T[];
  /** Keys another process claimed first (the duplicate we just prevented). */
  alreadyClaimed: string[];
  /** Keys whose claim write failed for some other reason — not dispatched. */
  errored: string[];
  /** Keys refused by the repetition guard (the same text, again, too soon). */
  repetitionBlocked: string[];
  /** True once the hourly sanity ceiling refused a group post. */
  breakerTripped: boolean;
}

/**
 * Filter a computed instruction list down to the ones this caller has
 * atomically claimed, respecting both outbound guards.
 *
 * `claim` must be a genuinely atomic write (Prisma `create` on the
 * `@unique` key, or `createMany({ skipDuplicates: true })`) that THROWS a
 * P2002 when the key is taken. A read-then-write "does this key exist?"
 * check would reintroduce exactly the race this fixes.
 *
 * Guard order and blast radius differ deliberately:
 *   - the hourly CEILING is a whole-org emergency stop: once it trips,
 *     no further group post goes out this cycle;
 *   - the REPETITION guard is per-message: it drops only the offending
 *     repeat and lets every other, different post through.
 * Neither guard ever touches a DM.
 *
 * Nothing blocked is CLAIMED, so its key stays free: once the condition
 * clears (or a human intervenes) the message can still be sent.
 */
export async function selectDispatchable<T extends Claimable>(
  instructions: T[],
  opts: {
    claim: (instr: T) => Promise<void>;
    /** Group posts already sent by this org inside the ceiling window. */
    recentGroupSends: number;
    cap?: number;
    /** Group texts this org has already sent, for the repetition guard.
     *  Omitted (or empty) simply means "no history" — the guard then only
     *  sees repeats inside this batch. */
    recentTexts?: readonly RecentOutboundText[];
    now?: Date;
    repetitionLimit?: number;
    repetitionWindowMs?: number;
    onBreak?: (info: BreakerVerdict) => void;
    onRepeat?: (info: RepetitionVerdict & { key: string; text: string }) => void;
    /** Persist a dispatched group post's hash so the NEXT poll can see
     *  it. Failures here are swallowed: a broken ledger must degrade the
     *  guard, never the bot. */
    recordText?: (info: { hash: string; key: string; instr: T }) => Promise<void>;
  },
): Promise<SelectDispatchableResult<T>> {
  const dispatch: T[] = [];
  const alreadyClaimed: string[] = [];
  const errored: string[] = [];
  const repetitionBlocked: string[] = [];
  let groupSends = opts.recentGroupSends;
  let breakerTripped = false;

  const now = opts.now ?? new Date();
  // Mutable so repeats WITHIN one batch are caught too, not just repeats
  // across polls.
  const recentTexts: RecentOutboundText[] = [...(opts.recentTexts ?? [])];

  for (const instr of instructions) {
    const groupDirected = isGroupDirected(instr.kind);
    let hash: string | null = null;

    if (groupDirected) {
      // Guard 2 first: if the org is already in a catastrophe, stop.
      const verdict = evaluateCircuitBreaker({ recentGroupSends: groupSends, cap: opts.cap });
      if (!verdict.allowed) {
        if (!breakerTripped) opts.onBreak?.(verdict);
        breakerTripped = true;
        continue;
      }

      // Guard 1: is this the same message, again, too soon?
      const text = outboundTextOf(instr);
      if (text !== null) {
        hash = hashOutboundText(text);
        const rep = evaluateRepetition({
          textHash: hash,
          recent: recentTexts,
          now,
          limit: opts.repetitionLimit,
          windowMs: opts.repetitionWindowMs,
        });
        if (!rep.allowed) {
          repetitionBlocked.push(instr.key);
          opts.onRepeat?.({ ...rep, key: instr.key, text });
          continue;
        }
      }
    }

    try {
      await opts.claim(instr);
      if (groupDirected) {
        groupSends += 1;
        if (hash) {
          recentTexts.push({ hash, at: now });
          try {
            await opts.recordText?.({ hash, key: instr.key, instr });
          } catch {
            // Ledger is best-effort. The message is already claimed and
            // is going out; a failed ledger write only means the next
            // poll under-counts this text.
          }
        }
      }
      dispatch.push(instr);
    } catch (err) {
      const outcome = classifyClaimError(err);
      if (outcome === "already-claimed") alreadyClaimed.push(instr.key);
      else errored.push(instr.key);
    }
  }

  return { dispatch, alreadyClaimed, errored, repetitionBlocked, breakerTripped };
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
