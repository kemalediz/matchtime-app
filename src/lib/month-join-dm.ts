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
 * WHICH QUESTION A DM ANSWERS: the one he quoted, or MatchTime's newest DM
 * (`dm-answering.ts`). An UNQUOTED DM while a "which of them?" is open, and
 * that the reader reads as his games or a sign-up for that month, answers
 * it too, even when other DMs came after it (2026-11-16).
 *
 * The message is always READ first. Anything that is not a sign-up for the
 * month goes on to the other DM handlers as before ("what time is kick
 * off?", "Paid"); an "out" closes the question and goes on as well, as a
 * plain message would. Every count is checked against the games he covers
 * (`fitGamesCommitted`) and is never stored when it does not fit: he is
 * asked again (at most three questions a month), and past that the answer
 * is still consumed and the organisers are told. A games answer to a
 * question one of whose games has been played since is not stored on a
 * guess: he is asked again with the games now left. A save the setter
 * refuses is never reported as stored. A closed question is never answered.
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
  /** He swipe-replied to a message (it is the one he answers). */
  quoted?: boolean;
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
    const asks = rows.map(openAskOf).filter((a): a is OpenAsk => !!a);
    const said = (await input.answering())?.trim();
    // The question he answers; unquoted, his newest open "which of them?"
    // too, when it is not the newest DM (read below: only his games act).
    const exact = said ? asks.find((a) => a.dm.trim() === said) : undefined;
    const ask = exact ?? (!input.quoted ? asks.find((a) => a.state !== null) : undefined);
    if (!ask) return null;
    const { orgId, monthId } = ask;
    try {
      await db.sentNotification.create({ data: { key: `org-${orgId}:msu:join-reply:${input.waMessageId}`, kind: "month-join-reply" } });
    } catch {
      return null; // this delivery was read already
    }
    const ms = await import("./month-signup");
    const month = await ms.loadSignupMonth(monthId);
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
          // What was said that the question is about: a plain "yes" keeps it.
          history: ask.state?.original ? [{ author: ask.state.originalBy ?? me?.name ?? null, body: ask.state.original }] : [],
          reply: { at: ask.createdAt, text: ask.dm, topic: null, match: null, author: null },
          now: input.now,
          dm: true,
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
    // Not about this month: it goes on to the other DM handlers, as before.
    if (reading.kind !== "signup" || reading.month !== month.monthNumber) return null;
    const close = () => db.sentNotification.updateMany({ where: { id: ask.id, kind: ask.kind }, data: { kind: `${ask.kind}-closed` } });
    if (reading.choice !== "in") {
      await close();
      // To "which of them?": an "out" is handled as the same plain message
      // would be (the other DM handlers). To the join question: a no.
      return ask.state ? null : { handled: "month-join-no", monthId };
    }
    /** Ask him again (a new question, toward the cap), or tell the organisers. */
    const askAgain = async (original: string | null, originalBy: string | null, games: number | null) => {
      await close();
      const fresh = (await ms.loadSignupMonth(monthId)) ?? month;
      const r = await ms.askOrNote({ month: fresh, userId: input.userId, now: input.now, original, originalBy, games, words: input.text });
      return { handled: (r === "asked" ? "month-join-asked" : "month-join-noted") as MonthJoinDmHandled, monthId };
    };
    /** A save the setter refused: never reported as stored. */
    const refused = async (saved: import("./month-signup").GamesSave) => {
      await close();
      const r = await ms.afterRefusedSave({ month: (await ms.loadSignupMonth(monthId)) ?? month, userId: input.userId, now: input.now, saved, words: input.text, games: reading.games });
      return { handled: (r === "asked" ? "month-join-asked" : "month-join-noted") as MonthJoinDmHandled, monthId };
    };
    const regular = month.members.some((x) => x.userId === input.userId && ms.isRegularMember(x));

    if (!ask.state) {
      // "Join <month> for the N games left?": he joins for the games he
      // covers (the games left, or a paid leaver's own). A count that does
      // not fit ("yes except the last week" read as every game) is asked
      // about instead.
      const fit = fitGamesCommitted(reading.games, ms.gamesCoverOf(month, input.userId, input.now).covers);
      if (fit.kind === "ask") return askAgain(input.text, null, reading.games);
      await close();
      const res = await ms.applySignup({ monthId, userId: input.userId, choice: "in", source: "reply", actorUserId: input.userId, games: fit.kind === "some" ? fit.games : null, now: input.now });
      if (!res.ok) return null;
      if (res.gamesSaved && res.gamesSaved !== "stored" && res.gamesSaved !== "unchanged") return refused(res.gamesSaved);
      return { handled: "month-join-yes", monthId };
    }

    // A game the question listed has been played since: no guessing which
    // of his were meant. He is asked again with the games now left.
    if (listed.some((d) => d.getTime() <= input.now.getTime())) return askAgain(ask.state.original ?? input.text, ask.state.originalBy, reading.games);

    // "Which of them will you play?": his answer is about the games it
    // listed; the games of his row already behind him are added to it.
    const fit = fitGamesCommitted(reading.games, listed.length);
    if (fit.kind === "ask") return askAgain(input.text, null, reading.games);
    const games = fit.kind === "some" ? fit.games + ask.state.pastCovered : null;
    if (regular) {
      const row = month.members.find((x) => x.userId === input.userId);
      if (row?.gamesCommitted === games) {
        await close();
        return { handled: "month-join-yes", monthId };
      }
      // On the month already: above the games he has played, while any are left.
      const played = await ms.gamesPlayedBy(monthId, input.userId, input.now);
      if (games !== null && fitGamesCommitted(games, ms.gamesCoverOf(month, input.userId, input.now).covers, played).kind !== "some") return askAgain(input.text, null, reading.games);
      const saved = await ms.commitMonthGamesResult(monthId, input.userId, games);
      if (saved !== "stored" && saved !== "unchanged") return refused(saved);
      await close();
      return { handled: "month-join-yes", monthId };
    }
    await close();
    const res = await ms.applySignup({ monthId, userId: input.userId, choice: "in", source: "reply", actorUserId: input.userId, games, now: input.now });
    if (!res.ok) return null;
    if (res.gamesSaved && res.gamesSaved !== "stored" && res.gamesSaved !== "unchanged") return refused(res.gamesSaved);
    return { handled: "month-join-yes", monthId };
  } catch (err) {
    console.error("[month-join-dm] failed:", err instanceof Error ? err.message : "failed");
    return null;
  }
}
