/**
 * ── BENCH-SLOT OFFER COPY ────────────────────────────────────────────
 *
 * Every sentence MatchTime uses to tell a benched player how to claim an
 * open slot, in one place, so the instruction cannot drift from what the
 * platform can actually receive.
 *
 * These are pure builders (no DB, no clock) and they are the single
 * source of truth for four surfaces:
 *
 *   1. the group post that tags the whole bench  (bot-scheduler)
 *   2. the 1:1 DM to each bencher                (bot-scheduler)
 *   3. the bot's day-one intro line              (bot-scheduler)
 *   4. the honest status line the server prepends when the model
 *      overclaims a promotion                    (message-analyzer)
 *
 * plus the phrasing example the LLM is handed in SYSTEM_PROMPT, because
 * the model writes group text too and will keep offering a 👍 however the
 * copy constants are set if the prompt still suggests it.
 *
 * House style: no em dashes, no en dashes, no slashes in prose.
 * ──────────────────────────────────────────────────────────────────── */

/**
 * Does the bench offer TELL players they can claim the slot with a 👍?
 *
 * ⚠️ FALSE, deliberately, and this is the highest-stakes instance of the
 * gate. This is the message that decides whether a club fields a full
 * side on match day.
 *
 * The handling is built and live: a 👍 on the group offer post resolves
 * the BenchSlotOffer (src/app/api/whatsapp/reaction/route.ts,
 * src/lib/bench-confirmation.ts) and an in-group "IN" or 👍 message is
 * read as a claim by the analyzer. NONE of that is being removed.
 *
 * What does not work is the platform underneath it, in BOTH directions,
 * verified on the Pi 2026-08-31:
 *
 *   • INBOUND: the bot drops every `message_reaction` event before the
 *     server is ever called. `whatsapp-bot/src/index.ts` (~600-621) logs
 *     `reaction-forwarding is unavailable`; there are ZERO successfully
 *     forwarded reactions, ever.
 *   • OUTBOUND: `SentNotification.waMessageId` has been NULL on every row
 *     since 18 July, so even a reaction that did arrive could not be
 *     mapped back onto the offer it was answering.
 *
 * So "React 👍 here to take it" asked a benched player to do something
 * that did absolutely nothing, while they believed they had claimed the
 * slot. The team then turns up a player short and nobody finds out until
 * kick-off. That is the silent-failure class this product has been
 * bleeding from, aimed at the one message we can least afford to lose.
 *
 * Deliberately a SEPARATE flag from RECRUIT_DM_MENTION_REACTIONS
 * (src/lib/recruit.ts), which gates the same instruction in the recruit
 * invite DM. Same evidence, same fix, but they are different features
 * with different stakes and they will be re-enabled independently: the
 * recruit DM can safely go first as a canary once forwarding returns,
 * because a missed recruit invite costs an invitation and a missed bench
 * claim costs the match. Coupling them would force one decision on two
 * risk levels.
 *
 * ── FLIP THIS BACK TO `true` WHEN ────────────────────────────────────
 * inbound reaction forwarding works again. The fix is in the bot, not
 * here: `whatsapp-bot/src/message-id.ts` (see §1b of
 * MDs/whatsapp-layer-independent-audit-2026-08-30.md; `msg.id` most
 * likely arrives as a STRING rather than the `{_serialized}` object and
 * `read()` throws it away). Verify BEFORE flipping, both halves:
 *   1. no new `reaction-forwarding is unavailable` lines in bot.err.log,
 *      and a test reaction reaching /api/whatsapp/reaction;
 *   2. recent `SentNotification` rows for kind "bench-prompt" carrying a
 *      non-null `waMessageId` (without it the reaction has no offer to
 *      map onto, so inbound alone is not enough).
 * Then this one line restores the 👍 instruction everywhere; nothing
 * else needs to change.
 */
export const BENCH_PROMPT_MENTION_REACTIONS = false;

/** Shared shape: every builder can be forced either way in tests, and
 *  defaults to the flag so production copy cannot drift from it. */
interface ReactionGate {
  /** Override the 👍 instruction gate. Tests only. */
  mentionReactions?: boolean;
}

export interface BenchOfferGroupCopy extends ReactionGate {
  /** Already-formatted context, e.g.
   *  "on *Reds* (replacing Ehtisham Ekin) for *Tuesday 7-a-side* tonight". */
  context: string;
  /** "@447700900001 @447700900002" — every bencher, whatsapp-mentioned. */
  tagList: string;
}

/** The group post that offers an open slot to the whole bench at once. */
export function buildBenchOfferGroupPost(c: BenchOfferGroupCopy): string {
  const reactions = c.mentionReactions ?? BENCH_PROMPT_MENTION_REACTIONS;
  const claim = reactions
    ? "React 👍 here or reply *IN* to take it."
    : "Just reply *IN* here to take it.";
  return (
    `🎟 A slot just opened ${c.context}. *First to claim it plays.*\n\n` +
    `${c.tagList}\n\n` +
    `${claim} No rush and no timeout, whoever is free first gets it ` +
    `and everyone else stays on the bench. 🙏`
  );
}

export interface BenchOfferDmCopy extends ReactionGate {
  /** First name, or "" when we have no name on record. */
  firstName: string;
  /** Plain-text context (no WhatsApp bold), e.g.
   *  "on Reds (replacing Ehtisham Ekin) for Tuesday 7-a-side tonight". */
  context: string;
}

/** The 1:1 nudge to each bencher. Benchers routinely mute the group
 *  thinking they are not playing, so the DM carries the same offer. */
export function buildBenchOfferDm(c: BenchOfferDmCopy): string {
  const reactions = c.mentionReactions ?? BENCH_PROMPT_MENTION_REACTIONS;
  const hi = c.firstName ? ` ${c.firstName}` : "";
  const claim = reactions
    ? "Reply *YES* here, tap 👍 on the message I tagged you in, or reply *IN* there."
    : "Reply *YES* here, or *IN* on the message I tagged you in, in the group.";
  return (
    `👋 Hi${hi}, a slot just opened ${c.context} and you're on the bench.\n\n` +
    `Want it? ${claim} First to claim plays. No timeout, and if you're ` +
    `not free no worries, you stay on the bench. 🙏`
  );
}

/** The bench line in the bot's day-one intro post. It is a promise about
 *  how the feature behaves, so it is gated with the feature. */
export function buildBenchIntroLine(c: ReactionGate = {}): string {
  const reactions = c.mentionReactions ?? BENCH_PROMPT_MENTION_REACTIONS;
  const how = reactions
    ? "the first to react 👍 or reply *IN* takes the slot"
    : "the first to reply *IN* takes the slot";
  return (
    `🔁  *Bench promotion* — If someone drops, I tag the bench here and ` +
    `${how}. No timeout, and nobody loses their place for missing it.`
  );
}

export interface BenchAskedLineCopy extends ReactionGate {
  benchName: string;
  confirmedCount: number;
  maxPlayers: number;
}

/** The honest status line the server prepends when the model claims a
 *  bench player has already moved up. It describes the IN-GROUP tag, and
 *  must never imply a private message was sent (a bencher who got no DM
 *  is right to call that misinformation). */
export function buildBenchAskedLine(c: BenchAskedLineCopy): string {
  const reactions = c.mentionReactions ?? BENCH_PROMPT_MENTION_REACTIONS;
  const how = reactions
    ? "they've been tagged here with a 👍 prompt"
    : "they're tagged here and just need to reply *IN*";
  return (
    `Asking *${c.benchName}* to step up, ${how}. ` +
    `Squad is *${c.confirmedCount}/${c.maxPlayers}* until they confirm.`
  );
}

/** The phrasing example handed to the LLM in SYSTEM_PROMPT. Quoted, so
 *  it drops straight into the list of approved wordings. */
export function benchClaimPhrasingExample(c: ReactionGate = {}): string {
  const reactions = c.mentionReactions ?? BENCH_PROMPT_MENTION_REACTIONS;
  return reactions
    ? `"<name>, you're up — 👍/👎 above"`
    : `"<name>, you're up, just reply IN here to take it"`;
}
