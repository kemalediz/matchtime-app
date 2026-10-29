/**
 * A PLAYER'S ANSWER TO "JOIN <MONTH> FOR THE GAMES LEFT?" (2026-10-29,
 * review of #465). Joining a month under way never rests on one reading:
 * MatchTime asks by DM (`askToJoinMonth`), and his reply is read by the
 * monthly reader (the same model step that reads every month sign-up, with
 * MatchTime's question as the message he replies to). A sign-up "in" for
 * that month joins him for the games left, as "IN FOR <month>" would; "out"
 * closes the ask; anything else goes on to the other DM handlers.
 *
 * Only while the ask is open and it is the message he is answering (the
 * quoted one, or MatchTime's newest DM to him); one delivery is read once.
 */
import { db } from "./db";
import { MONTH_JOIN_ASK_KIND } from "./month-signup";

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
      where: { kind: MONTH_JOIN_ASK_KIND, targetUser: input.userId, createdAt: { gte: new Date(input.now.getTime() - OPEN_MS) } },
      orderBy: { createdAt: "desc" },
      select: { id: true, key: true, text: true, createdAt: true },
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
    const { loadSignupMonth, applySignup } = await import("./month-signup");
    const month = await loadSignupMonth(monthId);
    if (!month || reading.month !== month.monthNumber) return null;
    // Answered either way: the ask is closed.
    await db.sentNotification.updateMany({ where: { id: ask.id, kind: MONTH_JOIN_ASK_KIND }, data: { kind: `${MONTH_JOIN_ASK_KIND}-closed` } });
    if (reading.choice !== "in") return { handled: "month-join-no", monthId };
    const res = await applySignup({ monthId, userId: input.userId, choice: "in", source: "reply", actorUserId: input.userId, now: input.now });
    return res.ok ? { handled: "month-join-yes", monthId } : null;
  } catch (err) {
    console.error("[month-join-dm] failed:", err instanceof Error ? err.message : "failed");
    return null;
  }
}
