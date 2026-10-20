/**
 * MATCHTIME'S LAST DM TO A PLAYER: what a DM classifier is told it last
 * said, so a reply is read against the question it answers.
 *
 * Lifted out of `payment-claim.ts` on 2026-10-18 so it has two readers and
 * one definition: the payment-claim classifier ("done" after a pay chase is
 * a claim, after a rating DM it is not) and the match-availability
 * classifier ("yes" after "Playing Tuesday?" is an IN, after anything else
 * it is nothing).
 *
 * DMs are recorded in two places. A queued `BotJob` keeps its words. A
 * scheduler DM handed out by /due-posts (the pay chase, the rating
 * reminder, the tentative follow-up) is only a `SentNotification` key, so
 * it is described by what its key is about: `topicOfDueKey`
 * (`due-key-feature.ts`), the scheduler's own key -> feature map plus the
 * tentative follow-up.
 *
 * DB-free except `loadLastBotDm`, which takes the client as an argument,
 * so the DB-free classifier modules (and their live dry runs) can import
 * `lastBotDmLine` without importing Prisma.
 */
import { topicOfDueKey } from "./due-key-feature";

/** How far back a scheduler DM still counts as the last thing said. */
export const LAST_DM_LOOKBACK_MS = 14 * 24 * 3600 * 1000;

/** What a scheduler DM was about, from its key. Null when the key says
 *  nothing useful. */
function describeScheduledDm(key: string): string | null {
  switch (topicOfDueKey(key)) {
    case "tentativeFollowup":
      return "(a question asking whether they can play in the match: in or out)";
    case "paymentCollection":
    case "paymentTracking":
      return "(a reminder to pay the match fee they owe, with their pay link)";
    case "playerRating":
      return "(a request to rate their teammates from the last match)";
    case "momVoting":
      return "(a Man of the Match vote)";
    case "attendance":
    case "bench":
      return "(a message about who is playing in a match)";
    default:
      return null;
  }
}

/**
 * The newer of the two wins. A newer scheduler DM that cannot be described
 * is "not known", never the stale BotJob: until 2026-10-18 only the BotJob
 * was read, so Feroz's daily pay chasers were invisible and the model saw
 * a two-day-old pay link as "last".
 */
export function pickLastBotDm(input: {
  queued: { text: string; at: Date } | null;
  scheduled: { key: string; at: Date } | null;
}): string | null {
  const { queued, scheduled } = input;
  if (scheduled && (!queued || scheduled.at.getTime() > queued.at.getTime())) {
    return describeScheduledDm(scheduled.key);
  }
  return queued?.text ?? null;
}

/** The two reads `loadLastBotDm` makes, as a structural type so a test
 *  can hand in a fake. Prisma's client satisfies it. */
export interface LastBotDmDb {
  botJob: {
    findFirst(args: {
      where: { kind: "dm"; phone: string };
      orderBy: { createdAt: "desc" };
      select: { text: true; createdAt: true; sentAt: true };
    }): Promise<{ text: string; createdAt: Date; sentAt: Date | null } | null>;
  };
  sentNotification: {
    findFirst(args: {
      where: { kind: "dm"; targetUser: string; createdAt: { gte: Date } };
      orderBy: { createdAt: "desc" };
      select: { key: true; createdAt: true };
    }): Promise<{ key: string; createdAt: Date } | null>;
  };
}

/** MatchTime's most recent DM to this player, from both places. `phone`
 *  is the BotJob's form (no "+"); null skips the BotJob side. */
export async function loadLastBotDm(
  db: LastBotDmDb,
  who: { phone: string | null; userId: string },
  now: Date = new Date(),
): Promise<string | null> {
  const [queued, scheduled] = await Promise.all([
    who.phone
      ? db.botJob.findFirst({
          where: { kind: "dm", phone: who.phone },
          orderBy: { createdAt: "desc" },
          select: { text: true, createdAt: true, sentAt: true },
        })
      : Promise.resolve(null),
    db.sentNotification.findFirst({
      where: { kind: "dm", targetUser: who.userId, createdAt: { gte: new Date(now.getTime() - LAST_DM_LOOKBACK_MS) } },
      orderBy: { createdAt: "desc" },
      select: { key: true, createdAt: true },
    }),
  ]);
  return pickLastBotDm({
    queued: queued ? { text: queued.text, at: queued.sentAt ?? queued.createdAt } : null,
    scheduled: scheduled ? { key: scheduled.key, at: scheduled.createdAt } : null,
  });
}

/** The line a classifier's user turn shows: stored words in quotes
 *  (capped), a bracketed description as it is, or "(not known)". */
export function lastBotDmLine(lastBotDm: string | null | undefined): string {
  if (!lastBotDm) return "(not known)";
  if (lastBotDm.startsWith("(") && lastBotDm.endsWith(")")) return lastBotDm;
  return JSON.stringify(lastBotDm.slice(0, 300));
}
