/**
 * A PLAYER'S ANSWER TO MATCHTIME'S MONTH QUESTIONS, by DM. Two questions,
 * one handler, both answered through the monthly reader (the same model
 * step that reads every month sign-up, with MatchTime's question as the
 * message he replies to, and the message marked as his DM):
 *
 *   "Join <month> for the N games left?" (2026-10-29, review of #465):
 *     joining a month under way never rests on one reading. A sign-up "in"
 *     joins him for the games he covers; "out" closes the ask.
 *   "Which of them will you play?" (2026-11-16): a count of his did not fit
 *     the games he covers. It lists the games still to play; his answer is
 *     read against them, with what was said before as the chat (a plain
 *     "yes" keeps it), and the games of his row already behind him added.
 *
 * Every count is checked against the games he covers (`fitGamesCommitted`)
 * and is never stored when it does not fit: he is asked again (at most
 * three questions a month), and past that the answer is still consumed and
 * the organisers are told once. A question one of whose games has been
 * played since it was asked is not answered on a guess: he is asked again
 * with the games now left. A question that is closed (he answered it, or
 * said a count that fits since) is never answered.
 *
 * Only while a question is open and it is the message he is answering (the
 * quoted one, or MatchTime's newest DM to him); one delivery is read once.
 */
import { db } from "./db";
import { formatLondon } from "./london-time";
import { MONTH_JOIN_ASK_KIND, MONTH_JOIN_WHICH_KIND, MONTH_WHICH_OPEN_MS, parseWhichAskState, type WhichAskState } from "./month-signup";
import { fitGamesCommitted } from "./squad-month-rules";

const OPEN_MS = 48 * 3600 * 1000;

interface OpenAsk {
  id: string;
  kind: string;
  createdAt: Date;
  dm: string;
  orgId: string;
  monthId: string;
  state: WhichAskState | null;
}

function openAskOf(a: { id: string; kind: string; key: string; text: string | null; createdAt: Date }): OpenAsk | null {
  if (a.kind === MONTH_JOIN_WHICH_KIND) {
    const state = parseWhichAskState(a.text);
    return state ? { id: a.id, kind: a.kind, createdAt: a.createdAt, dm: state.dm, orgId: state.orgId, monthId: state.monthId, state } : null;
  }
  // key: org-<orgId>:msu:join-ask:<monthId>:<userId>
  const m = /^org-(.+?):msu:join-ask:([^:]+):/.exec(a.key);
  return m && a.text ? { id: a.id, kind: a.kind, createdAt: a.createdAt, dm: a.text, orgId: m[1], monthId: m[2], state: null } : null;
}

export type MonthJoinDmHandled = "month-join-yes" | "month-join-no" | "month-join-asked" | "month-join-noted";

export async function handleMonthJoinDmReply(input: {
  userId: string;
  text: string;
  waMessageId: string;
  answering: () => Promise<string | null>;
  now: Date;
}): Promise<{ handled: MonthJoinDmHandled; monthId: string } | null> {
  try {
    const rows = await db.sentNotification.findMany({
      where: {
        kind: { in: [MONTH_JOIN_ASK_KIND, MONTH_JOIN_WHICH_KIND] },
        targetUser: input.userId,
        createdAt: { gte: new Date(input.now.getTime() - Math.max(OPEN_MS, MONTH_WHICH_OPEN_MS)) },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, key: true, kind: true, text: true, createdAt: true },
    });
    if (rows.length === 0) return null;
    const said = (await input.answering())?.trim();
    if (!said) return null;
    const ask = rows.map(openAskOf).find((a): a is OpenAsk => !!a && a.dm.trim() === said);
    if (!ask) return null;
    const { orgId, monthId } = ask;
    try {
      await db.sentNotification.create({ data: { key: `org-${orgId}:msu:join-reply:${input.waMessageId}`, kind: "month-join-reply" } });
    } catch {
      return null; // this delivery was read already
    }
    const { loadSignupMonth, applySignup, askOrNote, commitMonthGames, gamesCoverOf, gamesPlayedBy, isRegularMember } = await import("./month-signup");
    const month = await loadSignupMonth(monthId);
    if (!month) return null;
    const close = () => db.sentNotification.updateMany({ where: { id: ask.id, kind: ask.kind }, data: { kind: `${ask.kind}-closed` } });
    /** Ask him again (a new question, toward the cap), or tell the organisers. */
    const askAgain = async (original: string | null, originalBy: string | null, games: number | null) => {
      await close();
      const r = await askOrNote({ month, userId: input.userId, now: input.now, original, originalBy, games });
      return { handled: (r === "asked" ? "month-join-asked" : "month-join-noted") as MonthJoinDmHandled, monthId };
    };

    // A game it listed has been played since: never answered on a guess.
    const listed = (ask.state?.dates ?? []).map((d) => new Date(d));
    if (ask.state && listed.some((d) => d.getTime() <= input.now.getTime())) {
      return askAgain(ask.state.original, ask.state.originalBy, ask.state.games);
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
          // What was said that the question is about: a plain "yes" keeps it.
          history: ask.state?.original ? [{ author: ask.state.originalBy ?? me?.name ?? null, body: ask.state.original }] : [],
          reply: { at: ask.createdAt, text: ask.dm, topic: null, match: null, author: null },
          now: input.now,
          dm: true,
          ...(ask.state
            ? {
                answering: {
                  label: formatLondon(month.kickoffs[0] ?? month.firstKickoff, "MMMM yyyy"),
                  dates: listed.map((d) => ({ day: formatLondon(d, "EEE d MMM"), played: false })),
                },
              }
            : {}),
        },
        ctx,
      );
    });
    if (reading.kind !== "signup" || reading.month !== month.monthNumber) return null;
    if (reading.choice !== "in") {
      await close();
      return { handled: "month-join-no", monthId };
    }

    if (!ask.state) {
      // "Join <month> for the N games left?": he joins for the games he
      // covers (the games left, or a paid leaver's own). A count that does
      // not fit ("yes except the last week" read as every game) is asked
      // about instead.
      const fit = fitGamesCommitted(reading.games, gamesCoverOf(month, input.userId, input.now).covers);
      if (fit.kind === "ask") return askAgain(input.text, null, reading.games);
      await close();
      const res = await applySignup({ monthId, userId: input.userId, choice: "in", source: "reply", actorUserId: input.userId, games: fit.kind === "some" ? fit.games : null, now: input.now });
      return res.ok ? { handled: "month-join-yes", monthId } : null;
    }

    // "Which of them will you play?": his answer is about the games it
    // listed; the games of his row already behind him are added to it.
    const fit = fitGamesCommitted(reading.games, listed.length);
    if (fit.kind === "ask") return askAgain(input.text, null, reading.games);
    const games = fit.kind === "some" ? fit.games + ask.state.pastCovered : null;
    const regular = month.members.some((x) => x.userId === input.userId && isRegularMember(x));
    if (regular) {
      // On the month already: never below the games he has played.
      if (games !== null && games < (await gamesPlayedBy(monthId, input.userId, input.now))) return askAgain(input.text, null, reading.games);
      await close();
      await commitMonthGames(monthId, input.userId, games);
      return { handled: "month-join-yes", monthId };
    }
    await close();
    const res = await applySignup({ monthId, userId: input.userId, choice: "in", source: "reply", actorUserId: input.userId, games, now: input.now });
    return res.ok ? { handled: "month-join-yes", monthId } : null;
  } catch (err) {
    console.error("[month-join-dm] failed:", err instanceof Error ? err.message : "failed");
    return null;
  }
}
