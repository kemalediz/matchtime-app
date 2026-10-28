/**
 * CANCELLING A MATCH, AND PUTTING IT BACK ON: THE ONE CODE PATH
 * (2026-10-22).
 *
 * Two doors call this, each with its own authority check first:
 *
 *   - the web page's server action `cancelMatch` (app/actions/matches.ts),
 *     after `requireOrgAdmin` on the signed-in user;
 *   - the organisers' group, HQ (`admin-group-understand.ts`), after code
 *     has found the sender an owner or admin of the club;
 *   - the players' group (`admin-ops-engine-batch.ts` ->
 *     `playersGroupCancelOrRestore`, 2026-10-23), for a club with NO admin
 *     group only, by its owners and admins with an explicit tag. A club
 *     with HQ is pointed there.
 *
 * `cancelMatchById` sets the status, works out a monthly club's credits
 * (unchanged from the web action) and queues the players' group
 * announcement. `restoreMatchById` puts a cancelled match still to come
 * back to UPCOMING, the status the web's own restore (`bulkRestoreMatches`)
 * gives, and tells the players' group. The scheduler reads the status, so
 * the match's remaining reminders resume by themselves; posts already sent
 * before the cancel are not sent again (their SentNotification keys stay).
 *
 * A GAME THAT DID NOT HAPPEN (2026-10-28): the same core, for a match that
 * has kicked off in the last 7 days and has no score. It is CANCELLED with
 * no announcement, everything after the game is stopped (`stopAfterGame`),
 * and the caller replies only to the organiser who did it; the players hear
 * one line only if rating links had gone out. Restore puts such a game back
 * to COMPLETED, posting nothing.
 *
 * The HQ helpers below pick the match (`match-cancel-rules.ts`) and word
 * HQ's reply. HQ does not cancel for a club on monthly squads (Kemal,
 * 2026-10-22: not live); the caller answers that before reaching here.
 */
import { db } from "./db";
import { buildMatchCancelledAnnouncement } from "./group-copy";
import { dayMonthShortLabel, dayTimeLabel, weekdayLabel } from "./i18n/dates";
import { normaliseLang } from "./i18n/lang";
import { t } from "./i18n/t";
import { PAST_CANCEL_WINDOW_DAYS, isPastGame, pickHqMatch, pointsAtPast, withinPastCancelWindow, type HqMatchMode } from "./match-cancel-rules";
import { isMonthlyRow } from "./monthly-week";
import { cancelQueuedPlatformDms } from "./platform-jobs";

export type CancelResult =
  | { kind: "cancelled"; activityName: string; date: Date }
  | {
      kind: "not-played";
      activityName: string;
      date: Date;
      /** Players who had already paid for it (never refunded by MatchTime). */
      paidCount: number;
      /** Rating links had gone out for it. */
      ratingLinksSent: boolean;
      /** A monthly club's games of credit (`afterMatchesCancelled`). */
      creditedGames: number;
    }
  | { kind: "scored"; activityName: string; date: Date }
  | { kind: "already" | "completed" | "missing" | "too-old" };

/**
 * Cancel a match. Still to come: CANCELLED and the players' group told, as
 * since 2026-10-22. ALREADY KICKED OFF (2026-10-28, Kemal: "cancel the past
 * [matches] ... no need to ask for any score update or send any DMs or
 * ratings or man of the match"): inside `PAST_CANCEL_WINDOW_DAYS` and with
 * no score, CANCELLED, which every played reader excludes, and nothing
 * after the game is sent (`stopAfterGame`). No "match cancelled" post. The
 * caller words the reply to the organiser. When rating links had gone out,
 * one line tells the players' group they are closed, unless the caller
 * puts that line in its own reply in that group (`ratingsLineInReply`).
 */
export async function cancelMatchById(
  matchId: string,
  opts: { now?: Date; ratingsLineInReply?: boolean } = {},
): Promise<CancelResult> {
  const now = opts.now ?? new Date();
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: { select: { orgId: true, name: true, org: { select: { language: true, squadMode: true } } } } },
  });
  if (!match) return { kind: "missing" };
  if (match.status === "CANCELLED") return { kind: "already" };
  const past = isPastGame(match.date, now);
  if (!past && match.status === "COMPLETED") return { kind: "completed" };
  if (past) {
    if (!withinPastCancelWindow(match.date, now)) return { kind: "too-old" };
    // A score was reported, so it was played: nothing is taken back (its
    // Elo points included).
    if (match.redScore !== null && match.yellowScore !== null) return { kind: "scored", activityName: match.activity.name, date: match.date };
  }

  // Only from the status just read: two doors at once cancel (and announce) once.
  const res = await db.match.updateMany({ where: { id: matchId, status: match.status }, data: { status: "CANCELLED" } });
  if (res.count === 0) return { kind: "already" };

  const lang = normaliseLang(match.activity.org?.language);
  // MONTHLY SQUAD (slice 6, plan section 7 "A cancelled week"): for a club
  // on "monthly" whose month this game is in, every regular charged for it
  // gets one game of credit, and the announcement says so in the SAME
  // message (one post per event). A club on "weekly" makes no query here
  // and its announcement is byte for byte the plain one.
  let creditedGames = 0;
  if (match.activity.org?.squadMode === "monthly") {
    const { afterMatchesCancelled } = await import("./month-close");
    creditedGames = (await afterMatchesCancelled(match.activity.orgId, [matchId])).creditedGames;
  }

  if (past) {
    const stopped = await stopAfterGame(matchId, now);
    if (stopped.ratingLinksSent && !opts.ratingsLineInReply) {
      await db.botJob.create({ data: { orgId: match.activity.orgId, kind: "group", text: ratingsClosedLine(lang, match.date) } });
    }
    console.log(`[match-cancel] ${matchId}: marked as not played (${stopped.droppedJobs} queued job(s) dropped, ${stopped.paidCount} paid)`);
    return { kind: "not-played", activityName: match.activity.name, date: match.date, creditedGames, ...stopped };
  }

  let creditLine = "";
  if (creditedGames > 0) {
    const { buildCancelCreditLine } = await import("./month-close-copy");
    creditLine = `\n${buildCancelCreditLine({ count: 1, lang })}`;
  }
  await db.botJob.create({
    data: {
      orgId: match.activity.orgId,
      kind: "group",
      text: buildMatchCancelledAnnouncement({ activityName: match.activity.name, whenLabel: dayTimeLabel(lang, match.date), lang }) + creditLine,
    },
  });
  return { kind: "cancelled", activityName: match.activity.name, date: match.date };
}

/**
 * Everything after a game that did not happen, stopped. The scheduler reads
 * the status, so no score ask, rating DM or reminder, MoM post, badge post or
 * payment post is computed for it again; this takes care of what was queued
 * before the cancel, and reads what the reply must say:
 *
 *   queued BotJobs for the match       deleted (never sent; a BotJob has
 *                                      no status to mark)
 *   the after-game "join the club?"    unanswered ones withdrawn, their
 *   pool question                      queued DMs cancelled
 *   guests' results                    unsettled: the no-show sweep settles
 *                                      a cancelled game as no game
 *   rating links sent                  read from the rate-dm keys
 *   players who paid                   paid rows (a monthly regular's is the
 *                                      month's, credited instead) plus the
 *                                      players a bulk payment covered
 *
 * Ratings and Man of the Match votes already given are KEPT: every reader
 * excludes a cancelled match (`played-match.ts`), so putting the game back
 * brings them back.
 */
async function stopAfterGame(matchId: string, now: Date): Promise<{ droppedJobs: number; ratingLinksSent: boolean; paidCount: number }> {
  const dropped = await db.botJob.deleteMany({ where: { matchId, sentAt: null } });
  const invitations = await db.clubInvitation.findMany({
    where: { matchId, origin: "after-game", status: "open", playerYesAt: null, clubYesAt: null },
    select: { id: true },
  });
  if (invitations.length > 0) {
    const ids = invitations.map((i) => i.id);
    await cancelQueuedPlatformDms({ purposes: ["club-invite-ask"], refIds: ids, reason: "the game did not happen", now });
    await db.clubInvitation.updateMany({ where: { id: { in: ids }, status: "open" }, data: { status: "withdrawn", closedAt: now } });
  }
  await db.guestPlace.updateMany({ where: { matchId, settledAt: { not: null } }, data: { settledAt: null } });
  const [rateLinks, paidRows, credits] = await Promise.all([
    db.sentNotification.count({ where: { matchId, OR: [{ key: { startsWith: `${matchId}:rate-dm:` } }, { key: `${matchId}:rate-promo` }] } }),
    db.attendance.findMany({ where: { matchId, paidAt: { not: null } }, select: { paymentMethod: true } }),
    db.paymentCredit.findMany({ where: { matchId }, select: { count: true } }),
  ]);
  const paidCount = paidRows.filter((a) => !isMonthlyRow(a)).length + credits.reduce((n, c) => n + c.count, 0);
  return { droppedJobs: dropped.count, ratingLinksSent: rateLinks > 0, paidCount };
}

/** "Tuesday 5-a-side on 27 Oct" / "Tuesday 5-a-side (27 Ekim Salı)". */
export function notPlayedGameLabel(lang: string | null | undefined, activityName: string, date: Date): string {
  const l = normaliseLang(lang);
  return t(l).not_played_game({
    activityName,
    weekday: weekdayLabel(l, date),
    date: dayMonthShortLabel(l, date),
  });
}

/** The one players'-group line when rating links had gone out. */
export function ratingsClosedLine(lang: string | null | undefined, date: Date): string {
  const l = normaliseLang(lang);
  return t(l).not_played_ratings_closed({ weekday: weekdayLabel(l, date), date: dayMonthShortLabel(l, date) });
}

/** The organiser's reply to a game marked as not played: done, then who paid
 *  (to refund or credit) and a monthly club's credits. */
export function notPlayedReply(
  lang: string | null | undefined,
  r: Extract<CancelResult, { kind: "not-played" }>,
  extra?: string | null,
): string {
  const s = t(lang);
  const lines = [s.not_played_done({ game: notPlayedGameLabel(lang, r.activityName, r.date) })];
  if (r.paidCount > 0) lines.push(s.not_played_paid({ count: r.paidCount }));
  if (extra) lines.push(extra);
  return lines.join("\n");
}

export type RestoreResult =
  | { kind: "restored"; activityName: string; date: Date; past: boolean }
  | { kind: "not-cancelled" | "past" | "missing" };

/**
 * Put a cancelled match back. Still to come: UPCOMING and the players'
 * group told. ALREADY KICKED OFF, inside the window ("it did happen after
 * all"): COMPLETED, its ratings and votes count again, and nothing is
 * posted; the scheduler sends only what was never sent (its keys stay).
 */
export async function restoreMatchById(matchId: string, now: Date): Promise<RestoreResult> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: { select: { orgId: true, name: true, org: { select: { language: true } } } } },
  });
  if (!match) return { kind: "missing" };
  if (match.status !== "CANCELLED") return { kind: "not-cancelled" };
  const past = isPastGame(match.date, now);
  if (past && !withinPastCancelWindow(match.date, now)) return { kind: "past" };
  const res = await db.match.updateMany({ where: { id: matchId, status: "CANCELLED" }, data: { status: past ? "COMPLETED" : "UPCOMING" } });
  if (res.count === 0) return { kind: "not-cancelled" };
  // Its guests' results (player pool, slice L7; review of #404, 2): a game
  // back on is played and marked as any other, so nothing stays settled.
  await db.guestPlace.updateMany({ where: { matchId, settledAt: { not: null } }, data: { settledAt: null } });
  if (past) return { kind: "restored", activityName: match.activity.name, date: match.date, past: true };
  const lang = normaliseLang(match.activity.org?.language);
  await db.botJob.create({
    data: {
      orgId: match.activity.orgId,
      kind: "group",
      text: t(lang).match_back_on({ activityName: match.activity.name, whenLabel: dayTimeLabel(lang, match.date) }),
    },
  });
  return { kind: "restored", activityName: match.activity.name, date: match.date, past: false };
}

/** HQ outcomes that changed nothing: answered, but no ✅ (admin-group.ts). */
export const HQ_CANCEL_NOTHING_DONE = "hq-cancel-none";

/**
 * An organiser's cancel or "it's back on" in HQ. The caller has checked the
 * sender is an owner or admin and the club is weekly. `dayPhrase` is the
 * admin extractor's `matchDay`, `pastGame` its word that the game's time
 * has gone ("it didn't happen"). Null for a restore with nothing cancelled
 * when the message was not addressed to MatchTime: an organiser saying the
 * game is on is talking to the others.
 */
export async function hqCancelOrRestore(input: {
  orgId: string;
  lang: string | null;
  mode: HqMatchMode;
  dayPhrase: string | null;
  pastGame?: boolean;
  addressed: boolean;
  now: Date;
}): Promise<{ outcome: string; replyText: string } | null> {
  const s = t(input.lang);
  const r = await pickAndApply({ ...input, where: "HQ" });
  if (r.kind === "nothing-done") {
    if (r.replyText === null && !input.addressed) return null;
    return { outcome: HQ_CANCEL_NOTHING_DONE, replyText: r.replyText ?? s.hq_restore_no_match };
  }
  if (r.kind === "not-played") return { outcome: "hq-match-not-played", replyText: r.replyText };
  if (r.kind === "restored-played") return { outcome: "hq-match-played-restored", replyText: r.replyText };
  return appliedReply(input.lang, r);
}

function appliedReply(lang: string | null, r: { kind: "cancelled" | "restored"; activityName: string; date: Date }): { outcome: string; replyText: string } {
  const s = t(lang);
  const when = dayTimeLabel(lang, r.date);
  return r.kind === "cancelled"
    ? { outcome: "hq-match-cancelled", replyText: s.hq_match_cancelled({ activityName: r.activityName, when }) }
    : { outcome: "hq-match-restored", replyText: s.hq_match_restored({ activityName: r.activityName, when }) };
}

type Applied =
  | { kind: "cancelled" | "restored"; activityName: string; date: Date }
  /** A past game marked as not played, or put back as played: the reply. */
  | { kind: "not-played"; replyText: string }
  | { kind: "restored-played"; replyText: string }
  | { kind: "nothing-done"; replyText: string | null };

/**
 * The match chosen and the one core applied, for both groups. A
 * `nothing-done` carries the line saying why, or null for a restore with no
 * cancelled match to come (HQ stays quiet then unless it was asked).
 */
async function pickAndApply(input: {
  orgId: string;
  lang: string | null;
  mode: HqMatchMode;
  dayPhrase: string | null;
  pastGame?: boolean;
  now: Date;
  where: string;
  /** The players' group: the "rating links closed" line goes in the reply. */
  ratingsLineInReply?: boolean;
}): Promise<Applied> {
  const { orgId, mode, now } = input;
  const s = t(input.lang);
  const days = PAST_CANCEL_WINDOW_DAYS;
  const back = pointsAtPast(input.dayPhrase, input.pastGame);
  const matches = await db.match.findMany({
    where: { activity: { orgId }, isHistorical: false, date: { gt: new Date(now.getTime() - days * 24 * 3600_000) } },
    select: { id: true, date: true, status: true },
  });
  const match = pickHqMatch(matches, now, mode, input.dayPhrase, input.pastGame);
  const day = input.dayPhrase?.trim() ?? "";
  const none = (): Applied => {
    if (mode === "restore") return { kind: "nothing-done", replyText: back ? s.not_played_restore_none({ days }) : null };
    if (back) return { kind: "nothing-done", replyText: day ? s.not_played_none_day({ day, days }) : s.not_played_none({ days }) };
    return { kind: "nothing-done", replyText: day ? s.hq_cancel_no_match_day({ day }) : s.hq_cancel_no_match };
  };
  if (!match) return none();
  if (mode === "cancel") {
    const r = await cancelMatchById(match.id, { now, ratingsLineInReply: input.ratingsLineInReply });
    console.log(`[match-cancel] ${match.id}: cancel from ${input.where}: ${r.kind}`);
    if (r.kind === "cancelled") return r;
    if (r.kind === "scored") return { kind: "nothing-done", replyText: s.not_played_scored({ game: notPlayedGameLabel(input.lang, r.activityName, r.date) }) };
    if (r.kind !== "not-played") return { kind: "nothing-done", replyText: back ? s.not_played_none({ days }) : s.hq_cancel_no_match };
    const extra = [
      r.creditedGames > 0 ? (await import("./month-close-copy")).buildCancelCreditLine({ count: 1, lang: normaliseLang(input.lang) }) : null,
      input.ratingsLineInReply && r.ratingLinksSent ? ratingsClosedLine(input.lang, r.date) : null,
    ].filter(Boolean).join("\n");
    return { kind: "not-played", replyText: notPlayedReply(input.lang, r, extra || null) };
  }
  const r = await restoreMatchById(match.id, now);
  console.log(`[match-cancel] ${match.id}: restore from ${input.where}: ${r.kind}`);
  if (r.kind !== "restored") return { kind: "nothing-done", replyText: back ? s.not_played_restore_none({ days }) : s.hq_restore_no_match };
  if (r.past) return { kind: "restored-played", replyText: s.not_played_restored({ game: notPlayedGameLabel(input.lang, r.activityName, r.date) }) };
  return r;
}

/** Players'-group outcomes (`AnalyzedMessage.intent`). */
export const PLAYERS_CANCEL_OUTCOMES = {
  cancelled: "match_cancelled",
  restored: "match_restored",
  nothingDone: "match_cancel_none",
  organisersOnly: "match_cancel_organisers_only",
  useAdminGroup: "match_cancel_use_admin_group",
  monthly: "match_cancel_monthly",
  notPlayed: "match_not_played",
  restoredPlayed: "match_played_restored",
} as const;

/**
 * A TAGGED cancel or "it's back on" in the PLAYERS' group (2026-10-23,
 * Kemal). The caller has checked the explicit MatchTime tag; this decides
 * the rest, in this order:
 *
 *   not an owner or admin   the organisers-only line HQ uses
 *   the club has HQ         pointed at the admin group (HQ is where the
 *                           organisers do it; nothing is cancelled here)
 *   monthly squads          the website, as in HQ
 *   otherwise               the one core above. Done: no reply, a ✅. The
 *                           "Match cancelled" (or back on) post the core
 *                           queues IS the announcement in this group, so a
 *                           second line would say it twice.
 *                           A PAST game (2026-10-28) has no announcement:
 *                           the reply to the organiser says it is marked as
 *                           not played (or back as played), with the
 *                           "rating links closed" line in it when links had
 *                           gone out, and a ✅.
 */
export async function playersGroupCancelOrRestore(input: {
  orgId: string;
  lang: string | null;
  mode: HqMatchMode;
  dayPhrase: string | null;
  pastGame?: boolean;
  organiser: boolean;
  now: Date;
}): Promise<{ outcome: string; replyText: string | null; react: string | null }> {
  const s = t(input.lang);
  const O = PLAYERS_CANCEL_OUTCOMES;
  if (!input.organiser) {
    // Imported here: admin-group-understand imports this module.
    const { onlyOrganisersLine } = await import("./admin-group-understand");
    return { outcome: O.organisersOnly, replyText: await onlyOrganisersLine(input.orgId, input.lang), react: null };
  }
  const org = await db.organisation.findUnique({ where: { id: input.orgId }, select: { adminGroupId: true, squadMode: true } });
  if (org?.adminGroupId) return { outcome: O.useAdminGroup, replyText: s.match_cancel_use_admin_group, react: null };
  if (org?.squadMode === "monthly") return { outcome: O.monthly, replyText: s.hq_cancel_monthly, react: null };
  const r = await pickAndApply({ ...input, where: "the players' group", ratingsLineInReply: true });
  if (r.kind === "nothing-done") return { outcome: O.nothingDone, replyText: r.replyText ?? s.hq_restore_no_match, react: null };
  if (r.kind === "not-played") return { outcome: O.notPlayed, replyText: r.replyText, react: "✅" };
  if (r.kind === "restored-played") return { outcome: O.restoredPlayed, replyText: r.replyText, react: "✅" };
  return { outcome: r.kind === "cancelled" ? O.cancelled : O.restored, replyText: null, react: "✅" };
}
