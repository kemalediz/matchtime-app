/**
 * A PLAYER'S ANSWER TO MATCHTIME'S MONTH QUESTIONS, by DM. Two questions,
 * one handler, both answered through the monthly reader (the same model
 * step that reads every month sign-up, with MatchTime's question as the
 * message he replies to):
 *
 *   "Join <month> for the N games left?" (2026-10-29, review of #465):
 *     joining a month under way never rests on one reading. A sign-up "in"
 *     joins him for the games left; "out" closes the ask.
 *   "Which of them will you play?" (2026-11-16): his games did not fit the
 *     games he covers. It lists them; his answer is read against those
 *     dates, with what he said before as the chat (a plain "yes" keeps it).
 *
 * Every count is checked against the games he covers (`fitGamesCommitted`):
 * one that does not fit is never stored. To the join question it is asked
 * about instead; to the which question it stores nothing and leaves the
 * question open. Anything else goes on to the other DM handlers.
 *
 * Only while a question is open and it is the message he is answering (the
 * quoted one, or MatchTime's newest DM to him); one delivery is read once.
 */
import { db } from "./db";
import { formatLondon } from "./london-time";
import { MONTH_JOIN_ASK_KIND, MONTH_JOIN_WHICH_KIND, MONTH_WHICH_OPEN_MS, parseWhichAskState, type WhichAskState } from "./month-signup";
import { fitGamesCommitted, joinerGamesFromAnswer } from "./squad-month-rules";

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

export async function handleMonthJoinDmReply(input: {
  userId: string;
  text: string;
  waMessageId: string;
  answering: () => Promise<string | null>;
  now: Date;
}): Promise<{ handled: "month-join-yes" | "month-join-no" | "month-join-asked"; monthId: string } | null> {
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
    const { loadSignupMonth, applySignup, askWhichGames, commitMonthGames, gamesLeftIn, isRegularMember } = await import("./month-signup");
    const month = await loadSignupMonth(monthId);
    if (!month) return null;
    const listed = (ask.state?.dates ?? []).map((d) => new Date(d));
    const { loadMonthlyReaderContext, readMonthlyMessage } = await import("./monthly-reader");
    const { withOrgAiBudget } = await import("./ai-budget");
    const reading = await withOrgAiBudget(orgId, async () => {
      const ctx = await loadMonthlyReaderContext({ orgId, matchId: null, now: input.now });
      const me = ctx.members.find((x) => x.userId === input.userId);
      return readMonthlyMessage(
        {
          body: input.text,
          sender: { userId: input.userId, name: me?.name ?? null, organiser: me?.organiser ?? false },
          // What he said that the question is about: a plain "yes" keeps it.
          history: ask.state?.original ? [{ author: me?.name ?? null, body: ask.state.original }] : [],
          reply: { at: ask.createdAt, text: ask.dm, topic: null, match: null, author: null },
          now: input.now,
          ...(ask.state
            ? {
                answering: {
                  label: formatLondon(month.kickoffs[0] ?? month.firstKickoff, "MMMM yyyy"),
                  dates: listed.map((d) => ({ day: formatLondon(d, "EEE d MMM"), played: d.getTime() <= input.now.getTime() })),
                },
              }
            : {}),
        },
        ctx,
      );
    });
    if (reading.kind !== "signup" || reading.month !== month.monthNumber) return null;
    const close = () => db.sentNotification.updateMany({ where: { id: ask.id, kind: ask.kind }, data: { kind: `${ask.kind}-closed` } });

    if (!ask.state) {
      // "Join <month> for the N games left?": he joins for the games left,
      // so his count is checked against them. One that does not fit ("yes
      // except the last week" read as every game) is asked about instead.
      if (reading.choice !== "in") {
        await close();
        return { handled: "month-join-no", monthId };
      }
      const fit = fitGamesCommitted(reading.games, gamesLeftIn(month, input.now));
      if (fit.kind === "ask") {
        if (!(await askWhichGames({ month, userId: input.userId, now: input.now, original: input.text, games: reading.games }))) return null;
        await close();
        return { handled: "month-join-asked", monthId };
      }
      await close();
      const res = await applySignup({ monthId, userId: input.userId, choice: "in", source: "reply", actorUserId: input.userId, games: fit.kind === "some" ? fit.games : null, now: input.now });
      return res.ok ? { handled: "month-join-yes", monthId } : null;
    }

    // "Which of them will you play?": read against the games it listed.
    if (reading.choice !== "in") {
      await close();
      return { handled: "month-join-no", monthId };
    }
    const fit = fitGamesCommitted(reading.games, listed.length);
    if (fit.kind === "ask") {
      console.info(`[month-join-dm] ${input.userId}'s answer for ${monthId} does not fit the ${listed.length} games asked about: nothing stored, still open`);
      return null;
    }
    const regular = month.members.some((x) => x.userId === input.userId && isRegularMember(x));
    if (ask.state.regular && regular) {
      // His own games, on the month already: nothing played since changes them.
      await close();
      await commitMonthGames(monthId, input.userId, fit.kind === "some" ? fit.games : null);
      return { handled: "month-join-yes", monthId };
    }
    // Joining: a listed game played before he answered counts towards his games.
    const games = joinerGamesFromAnswer(fit, listed.length, listed.filter((d) => d.getTime() <= input.now.getTime()).length);
    await close();
    if (games.kind === "none" || games.kind === "ask") return { handled: "month-join-no", monthId };
    const res = await applySignup({ monthId, userId: input.userId, choice: "in", source: "reply", actorUserId: input.userId, games: games.kind === "some" ? games.games : null, now: input.now });
    return res.ok ? { handled: "month-join-yes", monthId } : null;
  } catch (err) {
    console.error("[month-join-dm] failed:", err instanceof Error ? err.message : "failed");
    return null;
  }
}
