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
 *
 * Language (2026-09-17): the group-facing builders read their words from
 * the string table (`src/lib/i18n/`) via the `lang` on `ReactionGate`.
 * ──────────────────────────────────────────────────────────────────── */
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";

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
  /** The group's language (`Organisation.language`). English when
   *  absent; the English bytes are unchanged either way (golden). Every
   *  group-facing builder reads it; the DM (`buildBenchOfferDm`) still
   *  speaks English whatever is passed (Phase 3). */
  lang?: Lang | string | null;
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
  return t(c.lang).bench_offer_group_post({ context: c.context, tagList: c.tagList, reactions });
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

/**
 * HOW A BENCH PLACE TURNS INTO A GAME, in one fragment.
 *
 * Extracted 2026-09-14 so the day-one PROMISE and the answer to a
 * recruit ask (`buildFullSquadBenchInvite`) cannot say different things
 * about the same mechanism. Both are promises made before there is any
 * offer to point at, both are read by people deciding whether it is
 * worth volunteering, and both have to move together when
 * BENCH_PROMPT_MENTION_REACTIONS flips. Two copies of one promise is one
 * copy too many: the flag would move one and leave the other lying.
 *
 * The wording is `buildBenchIntroLine`'s, unchanged.
 */
function benchPromotionHow(c: ReactionGate): string {
  const reactions = c.mentionReactions ?? BENCH_PROMPT_MENTION_REACTIONS;
  return t(c.lang).bench_promotion_how({ reactions });
}

/** The bench line in the bot's day-one intro post. It is a promise about
 *  how the feature behaves, so it is gated with the feature. */
export function buildBenchIntroLine(c: ReactionGate = {}): string {
  return t(c.lang).bench_intro_line({ how: benchPromotionHow(c) });
}

export interface FullSquadBenchInviteCopy extends ReactionGate {
  /** The activity name, e.g. "Tuesday 7-a-side". Rendered bold. */
  matchName: string;
  /** CONFIRMED right now. Printed, not rounded to "full". */
  confirmedCount: number;
  maxPlayers: number;
}

/**
 * ── THE ANSWER TO "ANY BENCHERS?" WHEN THE SQUAD IS FULL ─────────────
 *
 * 2026-09-14, Sutton FC, live. The owner posted, untagged:
 *
 *   "it would be great to have some benchers in case someone drops
 *    tomorrow? Anybody else interested"
 *
 * MatchTime replied "The squad for *Tuesday 7-a-side* is already full,
 * no open spots to recruit for." The match then kicked off at 14 of 14
 * with NOBODY on the bench.
 *
 * That answer is backwards, and it is not a wording problem. Benchers
 * are wanted PRECISELY BECAUSE the squad is full, and MatchTime already
 * does the thing he was asking for: a late IN into a full squad is
 * written as a BENCH row by the capacity rule (`attendance.ts`,
 * `engine.ts`), a confirmed player dropping opens ONE BenchSlotOffer
 * broadcast to every bencher, and the first to claim it plays. The
 * recruit path's capacity guard simply could not see any of that, so it
 * refused the volunteers and the club lost its cover.
 *
 * ── EVERY CLAUSE IS SOMETHING THE SYSTEM REALLY DOES ─────────────────
 *
 *   "full at N of M"         the count as the group can see it. Printed
 *                            rather than described so the reply is
 *                            checkable against the squad post above it.
 *   "say *IN* and I'll put   `registerAttendance` with a full squad
 *    you on the bench"       writes BENCH, today, with no admin step.
 *   "if someone drops"       `cancelAttendance` →
 *                            `requestBenchConfirmationOnDrop`, which
 *                            opens the offer only when a bench exists.
 *   benchPromotionHow()      the claim instruction, shared with the
 *                            day-one promise and gated on what the
 *                            platform can actually receive.
 *
 * ── WHY IT IS A GROUP REPLY AND NOT A DM BLAST ───────────────────────
 *
 * The tempting version of this fix DMs recent players inviting them to
 * the bench. It is deliberately NOT built. `recruit-lookback.ts`: "the
 * bot runs on an UNOFFICIAL WhatsApp client; a mass DM risks the account
 * being banned, which takes the whole product down." A reply in the
 * group reaches the same people, in the thread where they asked, at no
 * risk and no cost. The recruit path already refuses to DM into a full
 * squad; this changes what it SAYS, not what it sends.
 *
 * ── WHAT IT MUST NEVER SAY ───────────────────────────────────────────
 *
 * A 👍. Inbound reaction forwarding is dead on the Pi (see the essay on
 * BENCH_PROMPT_MENTION_REACTIONS at the top of this file), and this
 * sentence is read by somebody deciding whether to volunteer. Telling
 * them to tap something that does nothing is how a club turns up short
 * believing it has cover.
 */
export function buildFullSquadBenchInvite(c: FullSquadBenchInviteCopy): string {
  return t(c.lang).full_squad_bench_invite({
    matchName: c.matchName,
    confirmed: c.confirmedCount,
    maxPlayers: c.maxPlayers,
    how: benchPromotionHow(c),
  });
}

/**
 * ── THE CLOSING LINE OF THE "SQUAD COMPLETE" POST ────────────────────
 *
 * 2026-09-16, Sutton FC, live. MatchTime posted "✅ *Squad complete,
 * 14/14*" with the line-up, and the OWNER then had to ask the group
 * "can we have more players for bench please?" himself. His words: "i
 * shouldn't be asking this. When squad complete, MT should just show the
 * squad and ask for benchers to continue the INs flowing."
 *
 * So `squad-announce.ts` ends its post with this line when the org's
 * bench feature is on. Same message, never a second post: the owner has
 * said the group gets too many bot messages already.
 *
 * It is `buildFullSquadBenchInvite` without the "full at N of M" lead,
 * because the post it closes has just printed the count in its header
 * and the numbered roster under it. Every remaining clause is the same
 * promise, checked against the same code:
 *
 *   "say *IN* and I'll put    `registerAttendance` writes BENCH when the
 *    you on the bench"        squad has no room, with no admin step.
 *   "If someone drops out     `cancelAttendance` →
 *    I tag the bench here"    `requestBenchConfirmationOnDrop` opens a
 *                             BenchSlotOffer, and the scheduler posts the
 *                             tag in the group (only with the feature on,
 *                             which is why the caller gates on it).
 *   benchPromotionHow()       shared with the day-one promise and the
 *                             recruit answer, gated on what the platform
 *                             can actually receive.
 *
 * "here" rather than "in the group": this line is only ever read in the
 * group. `buildFullSquadBenchInvite` also reaches an admin by DM.
 */
export function buildSquadCompleteBenchInvite(c: ReactionGate = {}): string {
  return t(c.lang).squad_complete_bench_invite({ how: benchPromotionHow(c) });
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
  return t(c.lang).bench_asked_line({
    benchName: c.benchName,
    confirmed: c.confirmedCount,
    maxPlayers: c.maxPlayers,
    reactions,
  });
}

/** The phrasing example handed to the LLM in SYSTEM_PROMPT. Quoted, so
 *  it drops straight into the list of approved wordings. */
export function benchClaimPhrasingExample(c: ReactionGate = {}): string {
  const reactions = c.mentionReactions ?? BENCH_PROMPT_MENTION_REACTIONS;
  return reactions
    ? `"<name>, you're up — 👍/👎 above"`
    : `"<name>, you're up, just reply IN here to take it"`;
}

/**
 * Row 49: what the group is told when a bencher claims the open slot.
 * Moved verbatim from `bench-confirmation.ts` on 2026-09-17. Three
 * shapes, in the order that module tries them: a team to take over (the
 * replaced player had a team assignment), a replaced player with no
 * team yet, or an open slot with nobody to replace.
 */
export function buildBenchClaimAnnouncement(args: {
  claimerName: string;
  droppedName: string | null;
  teamLabel: string | null;
  confirmedCount: number;
  maxPlayers: number;
  lang?: Lang | string | null;
}): string {
  const s = t(args.lang);
  if (args.teamLabel && args.droppedName) {
    return s.bench_claim_team({ claimer: args.claimerName, dropped: args.droppedName, teamLabel: args.teamLabel });
  }
  if (args.droppedName) {
    return s.bench_claim_replacing({
      claimer: args.claimerName,
      dropped: args.droppedName,
      confirmed: args.confirmedCount,
      maxPlayers: args.maxPlayers,
    });
  }
  return s.bench_claim_open({ claimer: args.claimerName, confirmed: args.confirmedCount, maxPlayers: args.maxPlayers });
}
