/**
 * THE ADMIN STATS BLAST — the model classifies, the code acts.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE INCIDENT (2026-09-10, 18:38, Sutton FC, live)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Kemal posted an ordinary reminder to his players:
 *
 *   "please do not forget to rate the players via the link from
 *    Matchtime DM'ed to you. the more accurate ratings, the more
 *    balanced teams next time"
 *
 * MatchTime recorded `by=fast-path intent=stats_blast
 * action=dm-stats-blast:69` and queued 69 personal stats-link DMs. One
 * was delivered before the queue was killed; 68 were deleted unsent.
 *
 * The trigger, `analyze/route.ts:737`, was three keyword tests ANDed:
 *
 *     /\b(dm|send|share|message)\b/          ← "DM'ed to you"
 *     /\b(stats|ratings?)\b/                 ← "the more accurate ratings"
 *     /\b(everyone|all|active|players|…)\b/  ← "rate the players"
 *
 * Three unrelated fragments of ONE sentence. The sentence is an
 * instruction to the PLAYERS, not to the bot, and it means roughly the
 * opposite of what fired.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THE FIX IS NOT A FOURTH PATTERN
 * ═══════════════════════════════════════════════════════════════════════
 *
 * This is the exact class this codebase has now deleted three times,
 * each time after a production incident:
 *
 *   2026-04-21  `handlers.ts:7-10`, at Kemal's explicit request
 *   2026-09-01  `looksLikeRecruitRequest` — a pattern matched half a
 *               sentence, the rest was never analysed by anything, and
 *               MatchTime told the owner his squad was full one line
 *               after he said a player was out
 *   2026-09-10  this
 *
 * `recruit-request.ts` records the reasoning and it applies verbatim
 * here: it "made a REGEX do the classification and code do the action,
 * when this codebase's stated split is the opposite: the model extracts,
 * code decides and acts." A fourth keyword test, a negative lookahead or
 * an exclusion list would be a fourth thing to get wrong, in front of
 * the single most dangerous action in the product — `recruit-lookback.ts`
 * names the stake: "the bot runs on an UNOFFICIAL WhatsApp client; a
 * mass DM risks the account being banned, which takes the whole product
 * down."
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT REPLACED IT: THE RECRUIT BLAST'S SHAPE, EXACTLY
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   the extractor  reports the ask as a typed FACT —
 *                  `AdminFacts.action = "stats_blast"` on the
 *                  `admin_ops` route (`pipeline/extractors.ts`)
 *   the engine     GATES it — admin, and the tag rules below —
 *                  and emits a `stats_blast` write, which is a
 *                  DECISION and not an action (`pipeline/engine.ts`)
 *   the batch      turns that write into `statsBlastRequest` on the
 *                  message outcome and applies NOTHING
 *                  (`admin-ops-engine-batch.ts`)
 *   the route      performs the blast, deterministically, after every
 *                  write in the batch has landed, and composes the
 *                  reply from what ACTUALLY happened
 *
 * So the action is never the model's to invent, and no arrangement of
 * words can assemble one: the model can only ever say "this looks like
 * the ask", and three deterministic gates stand between that and a DM.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY LOST, SAID OUT LOUD
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   THE 🔒 DENIAL. The deleted fast path answered a non-admin with a 🔒
 *   react and an `stats_blast_denied` row. There is no regex left to
 *   recognise a non-admin's ask, so a non-admin who asks now gets
 *   silence plus one line on the operator note — the same treatment the
 *   recruit blast's deletion chose on 2026-09-01, and what the
 *   interaction contract already promises for anything MatchTime does
 *   not own.
 *
 *   THE CLAUSE PEEL. The blast was one of six clause-peeled fast paths,
 *   so "@Match Time send everyone their stats. Also I'm out" used to
 *   blast AND drop the sender. It cannot any more: `admin_ops` is a
 *   whole-message route, and a step-7 owner never sees a residual
 *   (`route.ts`'s second exclusion). The attendance half of a compound
 *   bulk-DM command is lost, exactly as it already is for a payment
 *   credit, a reminder and the recruit blast on the same route. It is
 *   the incident-6 shape and it is the honest price of deleting the
 *   predicate that made the peel possible — a peel needs a
 *   deterministic predicate, and a deterministic predicate over
 *   language is the thing that caused this. Recorded as a follow-up
 *   rather than smuggled in: the fix, if it is worth one, is a
 *   `sideRequests` entry on the ATTENDANCE extractor, which is how the
 *   recruit ask survives beside a drop.
 */

/**
 * Must an explicit bulk-DM command carry an @Match Time tag?
 *
 * ⚠️ THE SIBLING OF `RECRUIT_BLAST_REQUIRES_TAG`, and it is set the same
 * way for the same reasons. Read that constant's essay first; only the
 * differences are repeated here.
 *
 * YES, AND THE ARGUMENT IS THE INCIDENT ITSELF. A stats blast is an
 * explicit bulk-DM COMMAND. It is not a fact somebody is reporting (the
 * shape `RECRUIT_COMMAND_IMPLIES_ADDRESSED` widens the contract for),
 * it names no player and it changes no attendance — nothing is lost by
 * waiting for the sender to address the bot properly. And 2026-09-10 is
 * the proof that an untagged sentence CAN be mistaken for one: the
 * regex made that mistake, and no reading of the sentence guarantees
 * the model never will.
 *
 * THE COSTS ARE NOT SYMMETRIC, AND THAT DECIDES IT. A blast that does
 * not fire costs Kemal one re-typed message. A blast that fires wrongly
 * costs 69 DMs from an unofficial WhatsApp client and possibly the
 * account.
 *
 * Set to `false` and an untagged `stats_blast` fires on the model's word
 * alone. Do not.
 */
export const STATS_BLAST_REQUIRES_TAG = true;

/**
 * And must that tag be an EXPLICIT @-mention?
 *
 * ⚠️ THIS IS THE HALF THE RECRUIT BLAST DOES NOT HAVE YET, AND IT IS
 * WHAT MAKES THE INCIDENT SENTENCE REFUSED DETERMINISTICALLY.
 *
 * `messageTagsBot` counts the bare word "matchtime" ANYWHERE in a body
 * as a tag. The incident sentence contains it — "the link from Matchtime
 * DM'ed to you" — so `EngineMessage.tagged` is TRUE for the message that
 * queued 69 DMs. A tag gate reading that flag alone would have let it
 * through, and the whole fix would then rest on the model reading one
 * ambiguous sentence correctly, every time, at temperature 1.
 *
 * `messageMentionsBotExplicitly` (`interaction-contract.ts`) asks the
 * stricter question: the Pi's structured mention signal, or a literal
 * "@" in front of the name. That is a fact about the bytes the owner
 * sent — which is exactly what `RECRUIT_BLAST_REQUIRES_TAG` says a tag
 * is supposed to be, and what the loose fallback quietly stopped being.
 *
 * THE COST: "matchtime send everyone their stats", with no @, is
 * silence. One re-typed message.
 *
 * RECOMMENDED FOR THE RECRUIT BLAST TOO and deliberately NOT done here —
 * that path is out of this change's scope, and moving two mass-DM doors
 * in one PR is how a fix becomes the next incident.
 */
export const STATS_BLAST_TAG_MUST_BE_EXPLICIT = true;

/** One person the blast will DM: their id, their name, their phone. */
export interface StatsBlastRecipient {
  userId: string;
  name: string | null;
  /** E.164 or bare digits; the leading "+" is stripped on the way out. */
  phone: string;
}

/**
 * The blast's ENTIRE I/O surface, injected — so this module is a pure
 * function of three callbacks and a unit test can prove "nobody was
 * DM'd" without a database. The route builds the real three.
 */
export interface StatsBlastDeps {
  /** Every active member with a phone number. */
  recipients: () => Promise<StatsBlastRecipient[]>;
  /** That member's OWN never-expiring magic link to /profile/stats. */
  linkFor: (userId: string) => Promise<string>;
  queueDm: (args: { phone: string; text: string }) => Promise<void>;
}

/**
 * The DM, byte-for-byte what the deleted fast path sent. The copy is not
 * the thing that went wrong and a rewrite would be an unreviewed change
 * riding along with a fix.
 */
export function composeStatsBlastDm(name: string | null, url: string): string {
  const first = name?.split(" ")[0] ?? "there";
  return (
    `📊 Hi ${first} — here are your MatchTime stats: your ratings over time, ` +
    `Man-of-the-Match games, how you stack up against the squad, your badges and a ` +
    `shareable season card.\n\n${url}\n\nKeep this link — it doesn't expire.`
  );
}

/** The group reply, composed from what LANDED rather than what was asked
 *  for — §6.4's rule, and the reason the engine proposes no speech. */
export function composeStatsBlastReply(queued: number): string {
  return (
    `📊 Done — DM'd ${queued} player${queued === 1 ? "" : "s"} their personal stats link. ` +
    `They'll arrive over the next few minutes.`
  );
}

/**
 * QUEUE ONE STATS DM PER ACTIVE MEMBER.
 *
 * The deterministic action, unchanged in behaviour from the fast path it
 * replaces: same recipients, same copy, same never-expiring link, same
 * per-recipient error containment (one failed token must not cancel the
 * other 68). What changed is who is allowed to call it — see the two
 * constants above, and the gate in `pipeline/engine.ts`.
 *
 * It takes no decision of its own. By the time this runs the engine has
 * already decided that a blast may fire; this function's only judgement
 * is who is on the list.
 */
export async function runStatsBlast(
  deps: StatsBlastDeps,
): Promise<{ queued: number; failed: number }> {
  const people = await deps.recipients();
  let queued = 0;
  let failed = 0;
  for (const p of people) {
    if (!p.phone) continue;
    try {
      const url = await deps.linkFor(p.userId);
      await deps.queueDm({
        phone: p.phone.replace(/^\+/, ""),
        text: composeStatsBlastDm(p.name, url),
      });
      queued++;
    } catch (err) {
      failed++;
      console.error(`[stats-blast] DM failed for ${p.userId}:`, err);
    }
  }
  return { queued, failed };
}
