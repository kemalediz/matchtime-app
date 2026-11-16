/**
 * A PLAYER'S ANSWER TO "JOIN <MONTH> FOR THE GAMES LEFT?" (2026-10-29,
 * review of #465). Joining a month under way never rests on one reading:
 * MatchTime asks by DM (`askToJoinMonth`), and his reply is read by the
 * monthly reader (the same model step that reads every month sign-up, with
 * MatchTime's question as the message he replies to). A sign-up "in" for
 * that month joins him for the games left, as "IN FOR <month>" would; "out"
 * closes the ask; anything else goes on to the other DM handlers.
 *
 * The same handler answers the other question of that ask (2026-11-16):
 * "which of the games left will you play?", asked when the games he
 * committed to did not fit the games left. His answer is checked the same
 * way (`fitLateJoinGames`); one that still does not fit stores nothing and
 * leaves the question open.
 *
 * Only while the ask is open and it is the message he is answering (the
 * quoted one, or MatchTime's newest DM to him); one delivery is read once.
 */
import { db } from "./db";
import { MONTH_JOIN_ASK_KIND, MONTH_JOIN_WHICH_KIND } from "./month-signup";
import { fitLateJoinGames } from "./squad-month-rules";

const OPEN_MS = 48 * 3600 * 1000;

export async function handleMonthJoinDmReply(input: {
  userId: string;
  text: string;
  waMessageId: string;
  answering: () => Promise<string | null>;
  now: Date;
}): Promise<{ handled: "month-join-yes" | "month-join-no"; monthId: string } | null> {
  try {
    const ask = await db.sentNotification.findFirst({
      where: { kind: { in: [MONTH_JOIN_ASK_KIND, MONTH_JOIN_WHICH_KIND] }, targetUser: input.userId, createdAt: { gte: new Date(input.now.getTime() - OPEN_MS) } },
      orderBy: { createdAt: "desc" },
      select: { id: true, key: true, kind: true, text: true, createdAt: true },
    });
    if (!ask?.text) return null;
    if ((await input.answering())?.trim() !== ask.text.trim()) return null;
    // key: org-<orgId>:msu:join-ask:<monthId>:<userId>
    const m = /^org-(.+?):msu:join-ask:([^:]+):/.exec(ask.key);
    if (!m) return null;
    const [, orgId, monthId] = m;
    try {
      await db.sentNotification.create({ data: { key: `org-${orgId}:msu:join-reply:${input.waMessageId}`, kind: "month-join-reply" } });
    } catch {
      return null; // this delivery was read already
    }
    const { loadMonthlyReaderContext, readMonthlyMessage } = await import("./monthly-reader");
    const { withOrgAiBudget } = await import("./ai-budget");
    const reading = await withOrgAiBudget(orgId, async () => {
      const ctx = await loadMonthlyReaderContext({ orgId, matchId: null, now: input.now });
      const me = ctx.members.find((x) => x.userId === input.userId);
      return readMonthlyMessage(
        {
          body: input.text,
          sender: { userId: input.userId, name: me?.name ?? null, organiser: me?.organiser ?? false },
          history: [],
          reply: { at: ask.createdAt, text: ask.text, topic: null, match: null, author: null },
          now: input.now,
        },
        ctx,
      );
    });
    if (reading.kind !== "signup") return null;
    const { loadSignupMonth, applySignup, gamesLeftIn } = await import("./month-signup");
    const month = await loadSignupMonth(monthId);
    if (!month || reading.month !== month.monthNumber) return null;
    const left = gamesLeftIn(month, input.now);
    // The games he commits to. To "join for the N games left?" a plain yes
    // can come back with the question's own N, which is what he is joining
    // for anyway: only FEWER than the games left is a commitment. To
    // "which of them will you play?" a count that does not fit the games
    // left is no answer: nothing is stored and the question stays open.
    let games: number | null = null;
    if (reading.choice === "in") {
      if (ask.kind === MONTH_JOIN_WHICH_KIND) {
        const fit = fitLateJoinGames(reading.games, left);
        if (fit.kind === "ask") {
          console.info(`[month-join-dm] ${input.userId}'s answer for ${monthId} does not fit the ${left} games left: nothing stored, still open`);
          return null;
        }
        games = fit.kind === "some" ? fit.games : null;
      } else if (reading.games !== null && reading.games < left) {
        games = reading.games;
      }
    }
    // Answered either way: the ask is closed.
    await db.sentNotification.updateMany({ where: { id: ask.id, kind: ask.kind }, data: { kind: `${ask.kind}-closed` } });
    if (reading.choice !== "in") return { handled: "month-join-no", monthId };
    // His games are recorded by `applySignup`, before he is told what he owes.
    const res = await applySignup({ monthId, userId: input.userId, choice: "in", source: "reply", actorUserId: input.userId, games, now: input.now });
    return res.ok ? { handled: "month-join-yes", monthId } : null;
  } catch (err) {
    console.error("[month-join-dm] failed:", err instanceof Error ? err.message : "failed");
    return null;
  }
}
