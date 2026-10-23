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
 * The HQ helpers below pick the match (`match-cancel-rules.ts`) and word
 * HQ's reply. HQ does not cancel for a club on monthly squads (Kemal,
 * 2026-10-22: not live); the caller answers that before reaching here.
 */
import { db } from "./db";
import { buildMatchCancelledAnnouncement } from "./group-copy";
import { dayTimeLabel } from "./i18n/dates";
import { normaliseLang } from "./i18n/lang";
import { t } from "./i18n/t";
import { pickHqMatch, type HqMatchMode } from "./match-cancel-rules";

export type CancelResult =
  | { kind: "cancelled"; activityName: string; date: Date }
  | { kind: "already" | "completed" | "missing" };

export async function cancelMatchById(matchId: string): Promise<CancelResult> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: { select: { orgId: true, name: true, org: { select: { language: true, squadMode: true } } } } },
  });
  if (!match) return { kind: "missing" };
  if (match.status === "CANCELLED") return { kind: "already" };
  if (match.status === "COMPLETED") return { kind: "completed" };

  // Only from the status just read: two doors at once cancel (and announce) once.
  const res = await db.match.updateMany({ where: { id: matchId, status: match.status }, data: { status: "CANCELLED" } });
  if (res.count === 0) return { kind: "already" };

  const lang = normaliseLang(match.activity.org?.language);
  // MONTHLY SQUAD (slice 6, plan section 7 "A cancelled week"): for a club
  // on "monthly" whose month this game is in, every regular charged for it
  // gets one game of credit, and the announcement says so in the SAME
  // message (one post per event). A club on "weekly" makes no query here
  // and its announcement is byte for byte the plain one.
  let creditLine = "";
  if (match.activity.org?.squadMode === "monthly") {
    const { afterMatchesCancelled } = await import("./month-close");
    const { creditedGames } = await afterMatchesCancelled(match.activity.orgId, [matchId]);
    if (creditedGames > 0) {
      const { buildCancelCreditLine } = await import("./month-close-copy");
      creditLine = `\n${buildCancelCreditLine({ count: 1, lang })}`;
    }
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

export type RestoreResult = { kind: "restored"; activityName: string; date: Date } | { kind: "not-cancelled" | "past" | "missing" };

export async function restoreMatchById(matchId: string, now: Date): Promise<RestoreResult> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: { select: { orgId: true, name: true, org: { select: { language: true } } } } },
  });
  if (!match) return { kind: "missing" };
  if (match.status !== "CANCELLED") return { kind: "not-cancelled" };
  if (match.date.getTime() <= now.getTime()) return { kind: "past" };
  const res = await db.match.updateMany({ where: { id: matchId, status: "CANCELLED" }, data: { status: "UPCOMING" } });
  if (res.count === 0) return { kind: "not-cancelled" };
  const lang = normaliseLang(match.activity.org?.language);
  await db.botJob.create({
    data: {
      orgId: match.activity.orgId,
      kind: "group",
      text: t(lang).match_back_on({ activityName: match.activity.name, whenLabel: dayTimeLabel(lang, match.date) }),
    },
  });
  return { kind: "restored", activityName: match.activity.name, date: match.date };
}

/** HQ outcomes that changed nothing: answered, but no ✅ (admin-group.ts). */
export const HQ_CANCEL_NOTHING_DONE = "hq-cancel-none";

/**
 * An organiser's cancel or "it's back on" in HQ. The caller has checked the
 * sender is an owner or admin and the club is weekly. `dayPhrase` is the
 * admin extractor's `matchDay`. Null for a restore with nothing cancelled
 * when the message was not addressed to MatchTime: an organiser saying the
 * game is on is talking to the others.
 */
export async function hqCancelOrRestore(input: {
  orgId: string;
  lang: string | null;
  mode: HqMatchMode;
  dayPhrase: string | null;
  addressed: boolean;
  now: Date;
}): Promise<{ outcome: string; replyText: string } | null> {
  const s = t(input.lang);
  const r = await pickAndApply({ ...input, where: "HQ" });
  if (r.kind === "nothing-done") {
    if (r.replyText === null && !input.addressed) return null;
    return { outcome: HQ_CANCEL_NOTHING_DONE, replyText: r.replyText ?? s.hq_restore_no_match };
  }
  const when = dayTimeLabel(input.lang, r.date);
  return r.kind === "cancelled"
    ? { outcome: "hq-match-cancelled", replyText: s.hq_match_cancelled({ activityName: r.activityName, when }) }
    : { outcome: "hq-match-restored", replyText: s.hq_match_restored({ activityName: r.activityName, when }) };
}

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
  now: Date;
  where: string;
}): Promise<
  | { kind: "cancelled" | "restored"; activityName: string; date: Date }
  | { kind: "nothing-done"; replyText: string | null }
> {
  const { orgId, mode, now } = input;
  const s = t(input.lang);
  const matches = await db.match.findMany({
    where: { activity: { orgId }, isHistorical: false, date: { gt: now } },
    select: { id: true, date: true, status: true },
  });
  const match = pickHqMatch(matches, now, mode, input.dayPhrase);
  const day = input.dayPhrase?.trim() ?? "";
  if (!match) {
    if (mode === "restore") return { kind: "nothing-done", replyText: null };
    return { kind: "nothing-done", replyText: day ? s.hq_cancel_no_match_day({ day }) : s.hq_cancel_no_match };
  }
  const r = mode === "cancel" ? await cancelMatchById(match.id) : await restoreMatchById(match.id, now);
  if (r.kind !== "cancelled" && r.kind !== "restored") {
    console.log(`[match-cancel] ${mode} of ${match.id} from ${input.where}: ${r.kind}`);
    return { kind: "nothing-done", replyText: mode === "cancel" ? s.hq_cancel_no_match : s.hq_restore_no_match };
  }
  console.log(`[match-cancel] ${match.id}: ${r.kind} from ${input.where}`);
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
 */
export async function playersGroupCancelOrRestore(input: {
  orgId: string;
  lang: string | null;
  mode: HqMatchMode;
  dayPhrase: string | null;
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
  const r = await pickAndApply({ ...input, where: "the players' group" });
  if (r.kind === "nothing-done") return { outcome: O.nothingDone, replyText: r.replyText ?? s.hq_restore_no_match, react: null };
  return { outcome: r.kind === "cancelled" ? O.cancelled : O.restored, replyText: null, react: "✅" };
}
