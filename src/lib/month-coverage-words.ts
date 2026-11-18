/**
 * WHAT A MONTHLY REGULAR COVERS, BY TAGGING MATCHTIME IN HQ (Kemal,
 * 2026-11-16: every admin feature also works by WhatsApp).
 *
 *   "@Match Time Dan covers the whole month"
 *   "@Match Time Dan sadece kalan maçları ödüyor"
 *
 * The admin extractor reads the words (`month_coverage`: who, and
 * `coverage`, "whole" or "left" or neither said); nothing here reads them.
 * Who-is-who finds the regular among the live months' lists; the change is
 * the months page's own write (`setMonthMemberCoverage`). Words that do not
 * say which get ONE question, "whole month, or just the games left?",
 * logged as MatchTime's with the month and the player in its ask ref
 * (`coverageAskRef`). Its answer is found by `coverageAnswerTarget` (the
 * question a reply quotes, else the newest; "which player?" when it is not
 * clear) and read by the same extractor. An answer that NAMES somebody is
 * about that person, never the one asked about (review of #611, item 2).
 * The tagged add ("@Match Time add Tom, he's paid") asks the same question.
 *
 * Every reply says what the row says once written, never what was asked
 * for (item 4). An organiser's alone (the caller checks). Logs carry ids.
 */
import { db } from "./db";
import { recordMatchTimeLine, recordMatchTimeQuestion, type HqLogRow } from "./admin-group-log";
import { monthNameLabel } from "./i18n/dates";
import { monthSetupCopy } from "./i18n/month-setup";
import { joinChoice } from "./i18n/text";
import { CONFIRM_WINDOW_MS } from "./admin-group-confirm-rules";
import {
  COVERAGE_CHANGE_PREFIX,
  COVERAGE_CHANGE_TTL_MS,
  coverageAskRef,
  coverageChangeRef,
  coverageSettledPrefix,
  moneySig,
  parseCoverageAskRef,
  parseCoverageChangeRef,
  shownCoverage,
  type Coverage,
  type CoverageChange,
  type MonthCoverage,
} from "./month-coverage-rules";
import type { CoveragePreview } from "./month-member-coverage";
import { joinList } from "./i18n/text";

const DAY_MS = 24 * 60 * 60 * 1000;
import { refKey } from "./person-ref-key";
import type { PersonPicker } from "./pipeline/who-is-who";

export type CoverageWordsOutcome =
  | "month-coverage-done"
  | "month-coverage-same"
  | "month-coverage-asked"
  | "month-coverage-which"
  | "month-coverage-who"
  | "month-coverage-merged"
  | "month-coverage-failed"
  | "month-coverage-confirm"
  | "month-coverage-expired";

export interface CoverageWordsResult {
  outcome: CoverageWordsOutcome;
  replyText: string;
  /**
   * The questions asked ("whole month, or just the games left?"), for the
   * caller to log as MatchTime's with the WHOLE reply as their words, so a
   * quote of the reply finds every one of them (round 4, item 4).
   */
  asks?: Array<{ monthId: string; userId: string }>;
  /** A change that affects money, waiting for YES (Kemal, 2026-11-18):
   *  for the caller to log as MatchTime's question (`askCoverageChangeInHq`). */
  confirm?: CoverageChange;
}

/** One player's change waiting for YES, as the question says it. */
interface Pending {
  name: string;
  monthId: string;
  userId: string;
  monthDate: Date;
  preview: Extract<CoveragePreview, { ok: true }>;
}

/** "Make Dan cover the whole of November (5 games, £10 more)? Say YES." */
async function confirmText(lang: string | null, items: Pending[]): Promise<string> {
  const c = monthSetupCopy(lang);
  const { pounds } = await import("./month-payment-copy");
  const parts = items.map((i) => {
    const shown = shownCoverage({ gamesCovered: i.preview.gamesCovered, creditedCancelled: i.preview.creditedCancelled }, i.preview.month);
    const d = i.preview.deltaPence;
    return c.hq_cover_confirm_item({
      name: i.name,
      month: monthNameLabel(lang, i.monthDate),
      games: shown.games,
      of: shown.of,
      wholeMonth: shown.wholeMonth,
      amount: d ? pounds(Math.abs(d)) : null,
      more: (d ?? 0) > 0,
    });
  });
  const items_ = lang === "tr" ? parts.join("; ") : joinList(lang, parts);
  return c.hq_cover_confirm({ items: items_ });
}

const changeOf = (coverage: Coverage, items: Pending[]): CoverageChange => ({
  coverage,
  sig: moneySig(items.map((i) => i.preview.sig)),
  players: items.map((i) => ({ monthId: i.monthId, userId: i.userId })),
});

/** The marker that closes a coverage change question: a SentNotification,
 *  never a line of the organisers' log (nothing the router reads). */
const changeClosedKey = (questionId: string) => `coverage-change-closed:${questionId}`;

async function closeChange(questionId: string): Promise<void> {
  await db.sentNotification.create({ data: { key: changeClosedKey(questionId), kind: "coverage-change-closed" } }).catch(() => {});
}

/** Open coverage change questions (not closed), newest first. */
async function openChangeRows(orgId: string, since: Date): Promise<Array<{ waMessageId: string; askRef: string; createdAt: Date }>> {
  const rows = await db.adminGroupMessage.findMany({
    // MatchTime's question itself, never the safe-YES rule's "Is that YES to ...?" about it
    // (logged with the same ask ref, `mt:ask:`): its age is the question's.
    where: { orgId, fromMatchTime: true, askRef: { startsWith: COVERAGE_CHANGE_PREFIX }, createdAt: { gte: since }, NOT: { waMessageId: { startsWith: "mt:ask:" } } },
    orderBy: { createdAt: "desc" },
    select: { waMessageId: true, askRef: true, createdAt: true },
  });
  if (rows.length === 0) return [];
  const closed = new Set(
    (await db.sentNotification.findMany({ where: { key: { in: rows.map((r) => changeClosedKey(r.waMessageId)) } }, select: { key: true } })).map((x) => x.key),
  );
  return rows
    .filter((r) => r.askRef && !closed.has(changeClosedKey(r.waMessageId)))
    .map((r) => ({ waMessageId: r.waMessageId, askRef: r.askRef!, createdAt: r.createdAt }));
}

/**
 * Log a change waiting for YES as MatchTime's question, its whole reply as
 * its words. An open question about any of the same players is closed: the
 * newer words are what a YES is for. Never throws.
 */
export async function askCoverageChangeInHq(p: { orgId: string; change: CoverageChange; text: string; now: Date }): Promise<void> {
  try {
    const mine = new Set(p.change.players.map((x) => `${x.monthId}.${x.userId}`));
    for (const r of await openChangeRows(p.orgId, new Date(p.now.getTime() - DAY_MS))) {
      const c = parseCoverageChangeRef(r.askRef);
      if (c?.players.some((x) => mine.has(`${x.monthId}.${x.userId}`))) await closeChange(r.waMessageId);
    }
  } catch (err) {
    console.error("[month-coverage] closing older change questions failed:", err instanceof Error ? err.message : "failed");
  }
  await recordMatchTimeQuestion({ orgId: p.orgId, askRef: coverageChangeRef(p.change), text: p.text, now: p.now });
  console.log(`[month-coverage] a change for ${p.change.players.map((x) => x.userId).join(",")} waits for YES`);
}

/** The coverage changes waiting for YES, for what HQ is WAITING for
 *  (`loadPending`). A question past its 30 minutes still waits for a day,
 *  so its YES is answered "too old". */
export async function coverageChangesAwaiting(orgId: string, now: Date, lang: string | null): Promise<Array<{ ref: string; names: string; month: string; askedAt: Date }>> {
  const out: Array<{ ref: string; names: string; month: string; askedAt: Date }> = [];
  const seen = new Set<string>();
  for (const r of await openChangeRows(orgId, new Date(now.getTime() - DAY_MS))) {
    if (seen.has(r.askRef)) continue;
    seen.add(r.askRef);
    const c = parseCoverageChangeRef(r.askRef);
    if (!c) continue;
    const [users, month] = await Promise.all([
      db.user.findMany({ where: { id: { in: c.players.map((x) => x.userId) } }, select: { id: true, name: true } }),
      db.squadMonth.findUnique({ where: { id: c.players[0].monthId }, select: { monthStart: true } }),
    ]);
    const names = joinList(lang, c.players.map((x) => users.find((u) => u.id === x.userId)?.name ?? "?"));
    out.push({ ref: r.askRef, names, month: month ? monthNameLabel(lang, new Date(month.monthStart.getTime() + 12 * 3600_000)) : "", askedAt: r.createdAt });
  }
  return out;
}

/**
 * An organiser's YES to a coverage change, already matched to it by the
 * safe-YES rule. Past 30 minutes: nothing, and says so. The money changed
 * since it was asked (a price set, a payment): asked again with today's
 * numbers. Otherwise each player's change is applied, as the months page
 * does. Null: nothing waiting under that ref.
 */
export async function answerCoverageChangeYes(p: { orgId: string; lang: string | null; ref: string; now: Date }): Promise<CoverageWordsResult | null> {
  const change = parseCoverageChangeRef(p.ref);
  if (!change) return null;
  const row = (await openChangeRows(p.orgId, new Date(p.now.getTime() - DAY_MS))).find((r) => r.askRef === p.ref);
  if (!row) return null;
  const c = monthSetupCopy(p.lang);
  await closeChange(row.waMessageId);
  if (p.now.getTime() - row.createdAt.getTime() > COVERAGE_CHANGE_TTL_MS) return { outcome: "month-coverage-expired", replyText: c.hq_cover_confirm_expired };
  const { previewMonthMemberCoverage } = await import("./month-member-coverage");
  const { loadSignupMonth } = await import("./month-signup");
  const users = await db.user.findMany({ where: { id: { in: change.players.map((x) => x.userId) } }, select: { id: true, name: true } });
  const items: Pending[] = [];
  for (const x of change.players) {
    const m = await loadSignupMonth(x.monthId);
    const preview = await previewMonthMemberCoverage({ squadMonthId: x.monthId, userId: x.userId, coverage: change.coverage, now: p.now });
    if (!m || !preview.ok) continue;
    items.push({ name: users.find((u) => u.id === x.userId)?.name ?? "?", monthId: x.monthId, userId: x.userId, monthDate: m.firstKickoff, preview });
  }
  const now = changeOf(change.coverage, items);
  if (now.sig !== change.sig) {
    const ask = items.filter((i) => i.preview.changed && i.preview.needsYes);
    if (ask.length > 0) {
      const text = `${c.hq_cover_confirm_changed}\n${await confirmText(p.lang, ask)}`;
      return { outcome: "month-coverage-confirm", replyText: text, confirm: changeOf(change.coverage, ask) };
    }
  }
  const done: CoverageWordsResult[] = [];
  for (const i of items) {
    done.push(await applyCoverage({ orgId: p.orgId, lang: p.lang, monthId: i.monthId, userId: i.userId, name: i.name, monthDate: i.monthDate, coverage: change.coverage, now: p.now }));
  }
  if (done.length === 0) return { outcome: "month-coverage-failed", replyText: c.hq_cover_failed({ key: "failed", name: users[0]?.name ?? "", month: "" }) };
  const outcome = done.some((r) => r.outcome === "month-coverage-done") ? "month-coverage-done" : done[0].outcome;
  return { outcome, replyText: done.map((r) => r.replyText).join("\n") };
}

/**
 * One player's change in the organisers' group (Kemal, 2026-11-18): when it
 * affects money it waits for YES (the question returned in `confirm`, for
 * the caller to log); otherwise it is applied at once.
 */
export async function proposeOrApplyCoverage(p: {
  orgId: string;
  lang: string | null;
  monthId: string;
  userId: string;
  name: string;
  monthDate: Date;
  coverage: Coverage;
  now: Date;
}): Promise<CoverageWordsResult> {
  const { previewMonthMemberCoverage } = await import("./month-member-coverage");
  const preview = await previewMonthMemberCoverage({ squadMonthId: p.monthId, userId: p.userId, coverage: p.coverage, now: p.now });
  if (preview.ok && preview.changed && preview.needsYes) {
    const items: Pending[] = [{ name: p.name, monthId: p.monthId, userId: p.userId, monthDate: p.monthDate, preview }];
    return { outcome: "month-coverage-confirm", replyText: await confirmText(p.lang, items), confirm: changeOf(p.coverage, items) };
  }
  return applyCoverage(p);
}

/** The question's words for one regular of one month. "The whole month"
 *  counts its playable games (review item 7). */
export function coverageQuestionText(p: { lang: string | null; name: string; monthDate: Date; month: MonthCoverage }): string {
  return monthSetupCopy(p.lang).hq_cover_ask({ name: p.name, month: monthNameLabel(p.lang, p.monthDate), left: p.month.gamesLeft, whole: p.month.playable });
}

/**
 * Log the question as MatchTime's in HQ, with the month and the player in
 * its ask ref. `text` is the whole reply it goes out in (a reply quoting
 * it is matched by its words when its id is unknown). Never throws.
 */
export async function askCoverageInHq(p: { orgId: string; monthId: string; userId: string; text: string; now: Date }): Promise<void> {
  await recordMatchTimeQuestion({ orgId: p.orgId, askRef: coverageAskRef(p.monthId, p.userId), text: p.text, now: p.now });
  console.log(`[month-coverage] asked whole month or games left for ${p.userId} on ${p.monthId}`);
}

/**
 * Set what the regular covers and say so in one line, from the row as it
 * is stored afterwards. Used by the tagged change and by the answer. A
 * question about him asked before it is no longer open (logged line).
 *
 * NEVER a payment (review of #611, round 4, option a): what he paid, or
 * says he paid, is kept (`setMonthMemberCoverage` writes it down first),
 * whatever the words say about paying. When the change leaves him owing
 * more, or owed money back, the reply says so, with the months page's own
 * number (`loadMonthMoney`).
 */
export async function applyCoverage(p: {
  orgId: string;
  lang: string | null;
  monthId: string;
  userId: string;
  name: string;
  monthDate: Date;
  coverage: Coverage;
  now: Date;
}): Promise<CoverageWordsResult> {
  const c = monthSetupCopy(p.lang);
  const month = monthNameLabel(p.lang, p.monthDate);
  const { setMonthMemberCoverage } = await import("./month-member-coverage");
  const r = await setMonthMemberCoverage({ squadMonthId: p.monthId, userId: p.userId, coverage: p.coverage, now: p.now });
  if (!r.ok) return { outcome: "month-coverage-failed", replyText: c.hq_cover_failed({ key: r.error, name: p.name, month }) };
  // In playable games, one "of" everywhere (round 3, item 5).
  const words = { name: p.name, month, ...shownCoverage({ gamesCovered: r.gamesCovered, creditedCancelled: r.creditedCancelled }, r.month) };
  const balance = r.changed ? await balanceLine(p.lang, p.orgId, p.monthId, p.userId) : "";
  const out: CoverageWordsResult = r.changed
    ? { outcome: "month-coverage-done", replyText: `${c.hq_cover_done(words)}${balance}` }
    : { outcome: "month-coverage-same", replyText: c.hq_cover_same(words) };
  await recordMatchTimeLine({ orgId: p.orgId, idPrefix: coverageSettledPrefix(p.monthId, p.userId), text: out.replyText, now: p.now });
  return out;
}

/**
 * " He still shows £15 to pay." or " He shows £7.50 to give back.": what
 * the months page shows beside him (`loadMonthMoney`), or "" when nothing
 * is owed either way (round 4, item 4). Never throws.
 */
export async function balanceLine(lang: string | null, orgId: string, monthId: string, userId: string): Promise<string> {
  try {
    const { loadMonthMoney } = await import("./month-close");
    const pence = (await loadMonthMoney(orgId, [monthId]))[monthId]?.balances[userId] ?? 0;
    if (!pence) return "";
    const { pounds } = await import("./month-payment-copy");
    return ` ${monthSetupCopy(lang).hq_cover_balance({ owes: pence > 0, amount: pounds(Math.abs(pence)) })}`;
  } catch (err) {
    console.error("[month-coverage] the balance line failed:", err instanceof Error ? err.message : "failed");
    return "";
  }
}

/** A regular of a live month: who, where, and his name as the list has it. */
interface OnList {
  userId: string;
  name: string;
  monthId: string;
  monthDate: Date;
  started: boolean;
}

async function regularsOnLiveMonths(orgId: string, now: Date): Promise<OnList[]> {
  const { loadLiveMonths, hasStarted } = await import("./month-signup");
  const months = await loadLiveMonths(orgId, now);
  return months.flatMap((m) =>
    m.members
      .filter((x) => x.kind === "regular" && !x.out && !x.waiting)
      .map((x) => ({ userId: x.userId, name: x.name, monthId: m.id, monthDate: m.firstKickoff, started: hasStarted(m, now) })),
  );
}

/**
 * "@Match Time Dan covers the whole month": the admin extractor's
 * `month_coverage` with its `coveredRefs` and `coverage`. EVERY player
 * named is changed, and the reply names each (round 3, item 1: "Dan and
 * Ben cover the whole month" changes both). Each regular is found among
 * the live months' regulars; of the months he is on, the one under way (a
 * coming month covers every game anyway). Coverage not said: the question,
 * logged, for each. Never throws.
 */
export async function applyMonthCoverageWords(p: {
  orgId: string;
  lang: string | null;
  refs: string[];
  coverage: Coverage | null;
  body: string;
  senderName: string | null;
  senderUserId: string;
  now: Date;
  /** Tests: who-is-who. Absent: `personPickerFor`. */
  identify?: PersonPicker;
  /** The organisers' group: a change that affects money waits for YES
   *  (Kemal, 2026-11-18). */
  askFirst?: boolean;
}): Promise<CoverageWordsResult> {
  const c = monthSetupCopy(p.lang);
  try {
    const refs = [...new Set(p.refs.map((r) => r.trim().replace(/^@/, "")).filter(Boolean))];
    if (refs.length === 0) return { outcome: "month-coverage-who", replyText: c.hq_cover_who({ name: "" }) };
    const onList = await regularsOnLiveMonths(p.orgId, p.now);
    const ids = [...new Set(onList.map((x) => x.userId))];
    const aliases = ids.length > 0 ? await db.userAlias.findMany({ where: { orgId: p.orgId, userId: { in: ids } }, select: { userId: true, alias: true } }) : [];
    const roster = ids.map((userId) => ({
      userId,
      name: onList.find((x) => x.userId === userId)?.name ?? "",
      aliases: aliases.filter((a) => a.userId === userId).map((a) => a.alias),
      isAdmin: false,
      hasPhone: false,
    }));
    // Who each name is: who-is-who's pick among the month's regulars, one
    // call for the message, never a spelling match in code.
    const { identifyRefs, personPickerFor } = await import("./pipeline/identify-batch");
    const { people } = await identifyRefs({
      picker: p.identify ?? personPickerFor(),
      refs,
      body: p.body,
      author: p.senderName,
      senderUserId: p.senderUserId,
      roster,
      where: "HQ, the club organisers' admin group: what a regular on the month's list covers",
    });
    const results: CoverageWordsResult[] = [];
    const waiting: Pending[] = [];
    const done = new Set<string>();
    for (const ref of refs) {
      const pick = people.get(refKey(ref));
      const userId = pick?.kind === "member" && ids.includes(pick.userId) ? pick.userId : null;
      if (!userId) {
        results.push({ outcome: "month-coverage-who", replyText: c.hq_cover_who({ name: ref }) });
        continue;
      }
      if (done.has(userId)) continue;
      done.add(userId);
      const mine = onList.filter((x) => x.userId === userId).sort((a, b) => Number(b.started) - Number(a.started) || a.monthDate.getTime() - b.monthDate.getTime());
      const on = mine[0];
      const name = on.name || ref;
      if (!p.coverage) {
        const { loadCoverageView } = await import("./month-member-coverage");
        const v = await loadCoverageView(on.monthId, p.now);
        if (!v) {
          results.push({ outcome: "month-coverage-failed", replyText: c.hq_cover_failed({ key: "failed", name, month: monthNameLabel(p.lang, on.monthDate) }) });
          continue;
        }
        const text = coverageQuestionText({ lang: p.lang, name, monthDate: on.monthDate, month: v.month });
        // Logged by the caller, with the whole reply (round 4, item 4).
        results.push({ outcome: "month-coverage-asked", replyText: text, asks: [{ monthId: on.monthId, userId }] });
        continue;
      }
      if (p.askFirst) {
        // Kemal, 2026-11-18: a change that affects money waits for YES.
        const { previewMonthMemberCoverage } = await import("./month-member-coverage");
        const preview = await previewMonthMemberCoverage({ squadMonthId: on.monthId, userId, coverage: p.coverage, now: p.now });
        if (preview.ok && preview.changed && preview.needsYes) {
          waiting.push({ name, monthId: on.monthId, userId, monthDate: on.monthDate, preview });
          continue;
        }
      }
      results.push(await applyCoverage({ orgId: p.orgId, lang: p.lang, monthId: on.monthId, userId, name, monthDate: on.monthDate, coverage: p.coverage, now: p.now }));
    }
    let confirm: CoverageChange | undefined;
    if (waiting.length > 0 && p.coverage) {
      results.push({ outcome: "month-coverage-confirm", replyText: await confirmText(p.lang, waiting) });
      confirm = changeOf(p.coverage, waiting);
    }
    // One reply naming each; its outcome the best of them (a change made).
    const rank: CoverageWordsOutcome[] = ["month-coverage-done", "month-coverage-confirm", "month-coverage-asked", "month-coverage-same", "month-coverage-failed", "month-coverage-who"];
    const outcome = rank.find((o) => results.some((r) => r.outcome === o)) ?? "month-coverage-who";
    const asks = results.flatMap((r) => r.asks ?? []);
    return { outcome, replyText: results.map((r) => r.replyText).join("\n"), ...(asks.length > 0 ? { asks } : {}), ...(confirm ? { confirm } : {}) };
  } catch (err) {
    console.error("[month-coverage] the tagged change failed:", err instanceof Error ? err.message : "failed");
    return { outcome: "month-coverage-failed", replyText: c.hq_cover_failed({ key: "failed", name: p.refs[0] ?? "", month: "" }) };
  }
}

/**
 * The organiser's answer to "whole month, or just the games left?" that
 * names nobody, read by the admin extractor: the month and the player
 * come from the question's ask ref, the coverage from his words. Null when
 * the answer says neither (the message is then handled as it would have
 * been). A player merged since the question (the "who is this?" answer
 * folds a new player into a member, `applyUserMerge`, and switches the old
 * one off) is followed to the survivor by the merge's `UserMerge`
 * tombstone (round 3, item 2), as `submitRatings` does; "That player was
 * merged..." only when no survivor is found.
 */
export async function answerCoverageQuestion(p: {
  orgId: string;
  lang: string | null;
  asked: { monthId: string; userId: string };
  coverage: Coverage | null;
  now: Date;
}): Promise<CoverageWordsResult | null> {
  if (!p.coverage) return null;
  try {
    const month = await db.squadMonth.findFirst({ where: { id: p.asked.monthId, orgId: p.orgId }, select: { id: true } });
    if (!month) return null;
    const who = await survivorOf(p.asked.userId);
    if (!who) return { outcome: "month-coverage-merged", replyText: monthSetupCopy(p.lang).hq_cover_merged };
    const { loadSignupMonth } = await import("./month-signup");
    const m = await loadSignupMonth(p.asked.monthId);
    if (!m) return null;
    return await applyCoverage({ orgId: p.orgId, lang: p.lang, monthId: m.id, userId: who.userId, name: who.name || "?", monthDate: m.firstKickoff, coverage: p.coverage, now: p.now });
  } catch (err) {
    console.error("[month-coverage] the answer failed:", err instanceof Error ? err.message : "failed");
    return null;
  }
}

/**
 * The player a question was about, now: himself while he is an active
 * user; else the survivor his merge tombstones (`UserMerge`, old id to
 * survivor) lead to, followed with a small hop cap and a cycle guard (as
 * `ratings.ts` `resolveMergeSurvivor`). Null when no active survivor is
 * found.
 */
async function survivorOf(userId: string): Promise<{ userId: string; name: string | null } | null> {
  let current = userId;
  const seen = new Set<string>();
  for (let hop = 0; hop < 6; hop++) {
    if (seen.has(current)) return null;
    seen.add(current);
    const user = await db.user.findUnique({ where: { id: current }, select: { name: true, isActive: true } });
    if (user?.isActive) return { userId: current, name: user.name };
    const merge = await db.userMerge.findFirst({ where: { oldUserId: current }, orderBy: { createdAt: "desc" }, select: { survivorUserId: true } });
    if (!merge) return null;
    current = merge.survivorUserId;
  }
  return null;
}

/** The id prefix of MatchTime's "which player do you mean?" line. */
export const COVERAGE_WHICH_LINE_PREFIX = "mt:said:coverage-which:";

/**
 * An answer to "whole month, or just the games left?" that names nobody,
 * when questions about two or more players are open and it is not clear
 * which it answers (review item 3): ONE line asking which player. Not
 * asked again within the window: null, and the message is handled as it
 * would have been. Never throws.
 */
export async function askWhichCoveragePlayer(p: {
  orgId: string;
  lang: string | null;
  userIds: string[];
  log: HqLogRow[];
  now: Date;
  /** The answer quotes MatchTime's reply asking about them: always answered. */
  quoted?: boolean;
}): Promise<CoverageWordsResult | null> {
  try {
    // Asked already about THESE questions: a which-line since the newest of
    // them (questions asked after it are new, and are asked about).
    const newestAsk = Math.max(0, ...p.log.filter((r) => r.fromMatchTime && parseCoverageAskRef(r.askRef)).map((r) => r.createdAt.getTime()));
    const saidLately = p.log.some(
      (r) => r.fromMatchTime && r.waMessageId.startsWith(COVERAGE_WHICH_LINE_PREFIX) && p.now.getTime() - r.createdAt.getTime() <= CONFIRM_WINDOW_MS && r.createdAt.getTime() >= newestAsk,
    );
    if (saidLately && !p.quoted) return null;
    const users = await db.user.findMany({ where: { id: { in: p.userIds } }, select: { id: true, name: true } });
    const names = p.userIds.map((id) => users.find((u) => u.id === id)?.name).filter((n): n is string => !!n);
    if (names.length === 0) return null;
    const text = monthSetupCopy(p.lang).hq_cover_which({ names: joinChoice(p.lang, names), first: names[0].split(" ")[0] });
    await recordMatchTimeLine({ orgId: p.orgId, idPrefix: COVERAGE_WHICH_LINE_PREFIX, text, now: p.now });
    return { outcome: "month-coverage-which", replyText: text };
  } catch (err) {
    console.error("[month-coverage] the which-player line failed:", err instanceof Error ? err.message : "failed");
    return null;
  }
}
