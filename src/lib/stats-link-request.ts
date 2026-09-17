/**
 * THE PERSONAL STATS LINK — the model classifies, the code acts, and the
 * recipient is the asker.
 *
 * Until 2026-09-17 this was the `STATS_REQUEST` fast path in
 * `analyze/route.ts`:
 *
 *   /\bwrapped\b|\bmy\s+(stats|season|ratings?|performance|form|card)\b/i
 *
 * English only, so the Turkish help's advertised "@Match Time
 * istatistiklerim" did nothing, and a pattern deciding what a message
 * means, which this codebase has removed everywhere else
 * (`lib/stats-blast.ts` has the history). It matched 0 real messages in
 * 143 days (`MDs/router-accuracy-2026-09-11.md` §1.9), so converting it
 * was low-risk; §2.5 of that document is the design followed here:
 *
 *   the extractor  `QuestionFacts.topic = "my_stats"` on the `question`
 *                  route (NOT `admin_ops`: a personal DM stays away from
 *                  the route that guards the mass-DM doors)
 *   the engine     gates it (tag, resolved sender) and sets
 *                  `MessageOutcome.statsLinkRequested`, a BOOLEAN
 *   the batch      reports `statsLinkRequest` on that message's outcome
 *   the route      calls this, with the SENDER of that message
 *
 * WHO GETS IT. This function's only person-shaped input is `sender`, the
 * resolved author of the asking message. There is no recipient parameter
 * and nothing upstream carries one, so no arrangement of words can send
 * someone else's link, or send a link to someone else.
 *
 * WHAT IS DELIBERATELY LOST, SAID OUT LOUD. The clause peel. "@Match Time
 * my stats. Also I'm out" used to DM the link AND drop the sender; the
 * `question` route is a whole-message route, so now the link is sent and
 * the OUT is lost, exactly as for the rating-progress ask and the stats
 * blast. Observed occurrences of that shape in 143 days: zero.
 *
 * The DM copy and the 48h link are unchanged from the fast path.
 */
import { buildStatsLinkDm } from "./dm-copy";
import type { Lang } from "./i18n/lang";

export interface StatsLinkSender {
  /** The resolved author of the asking message, or null. */
  userId: string | null;
  name: string | null;
  /** The user row's phone, E.164 or bare digits. */
  phone: string | null;
}

export interface StatsLinkDeps {
  /** A short magic link to THIS user's own /profile/stats. */
  linkFor: (userId: string) => Promise<string>;
  queueDm: (dm: { phone: string; text: string }) => Promise<void>;
}

export async function sendOwnStatsLink(args: {
  sender: StatsLinkSender;
  /** The phone the message arrived from, the fast path's fallback. */
  authorPhone: string | null;
  lang: Lang | string | null | undefined;
  deps: StatsLinkDeps;
}): Promise<{ queued: boolean; reason: string }> {
  const { sender, deps } = args;
  const phone = (sender.phone || args.authorPhone || "").replace(/^\+/, "");
  if (!sender.userId) return { queued: false, reason: "unresolved sender: nobody to DM" };
  if (!phone) return { queued: false, reason: "the sender has no phone on record" };
  try {
    const url = await deps.linkFor(sender.userId);
    await deps.queueDm({ phone, text: buildStatsLinkDm({ name: sender.name, url, lang: args.lang }) });
    return { queued: true, reason: "personal stats request: DM'd a magic link to /profile/stats" };
  } catch (err) {
    return { queued: false, reason: `the stats-link DM could not be queued (${err instanceof Error ? err.message : String(err)})` };
  }
}
