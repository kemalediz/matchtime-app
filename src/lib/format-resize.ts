/**
 * SWITCH ONE MATCH TO ANOTHER SIZE INSIDE ITS GAME'S RANGE (2026-11-03, the
 * Vets play 6, 7 or 8 a side). THE ONE CORE for every door: the switch
 * page's server action, an organiser tagging MatchTime ("@Match Time make it
 * 8 aside", "@Match Time 6 kişilik oynayalım") in the players' group or HQ,
 * and an organiser's yes to MatchTime's own suggestion to go up a size.
 *
 * NO AUTHORISATION LIVES HERE. Every caller checks the sender is an owner or
 * admin first, as for every admin action.
 *
 * CONCURRENCY (review of #517). One transaction that takes, in this order,
 * the per-match slot lock every bench path takes (`team-slots:`) and the
 * week's lock the monthly slot writer takes (`monthly-week:`); no path
 * takes them the other way round. Under them it locks the Match row and the
 * squad's Attendance rows (`FOR UPDATE`), so an IN or OUT already writing a
 * row is waited for and read as it committed, and one arriving later waits
 * for the switch. The size is re-read under the lock: a second switch to
 * the same size does nothing (idempotent, one list post). Each move is a
 * conditional write on the status it was read with.
 *
 * WHAT IT DOES:
 *   - `Match.maxPlayers` becomes the new places. The match stays on its own
 *     Activity: no second match, no new kickoff (see flex-format-rules.ts
 *     for why this is not `switchMatchFormat`).
 *   - UP: the bench moves in, in bench order (`planResize`), except a player
 *     who asked to be on the bench. Each gets a DM that he is in, and pays as
 *     he goes (for a monthly club, the PAYG price, named only when the club
 *     takes payments). A club whose organisers pick from the bench
 *     (`benchPickMode = "organiser"`) moves nobody: the places open, and the
 *     organiser pick round asks them who comes in, as for any open place.
 *   - DOWN: the squad above the new size goes to the bench, the last to join
 *     first, a monthly club's regulars after every non-regular. Each is told
 *     by DM.
 *   - Line-ups already made are cleared (they were for the old size).
 *   - Open bench offers and bench asks for places that no longer exist are
 *     closed; every size passed through is settled for the suggestion.
 * Then the new list is posted, held through the club's quiet hours: the
 * month's week list for a monthly club (nothing until its regulars are on
 * the match), the roster for a weekly one (with the "squad shown" marker,
 * and the squad-full claim when it is full now), to the organisers instead
 * when they announce the list. The moved players' slot reactions are
 * refreshed.
 */
import { db } from "./db";
import { appUrl } from "./app-url";
import { recordAttendanceEvent } from "./attendance-events";
import { adminNoticeSendAfter } from "./rolling-squad-rules";
import { loadClubQuietHours } from "./club-quiet-hours";
import { weekdayLabel } from "./i18n/dates";
import { flexFormatCopy } from "./i18n/flex-format";
import { normaliseLang } from "./i18n/lang";
import { paymentMessagesOn } from "./payment-messages";
import { paygPriceLabel } from "./monthly-week-copy";
import { organisersAnnounce } from "./list-announcer";
import { buildOrganiserRelay } from "./organisers-list-copy";
import { sendAdminNotice } from "./admin-channel";
import { loadPlayerNames } from "./player-display-name";
import { ROSTER_SHOWN_KIND, rosterShownKey, squadFingerprint } from "./roster-shown";
import { formatUpSettledKey, planResize, playerRange, sideAllowed, sidesInRange, type ResizeRow } from "./flex-format-rules";

export type ResizeOutcome =
  | "format-switched"
  | "format-unchanged"
  | "format-not-allowed"
  | "format-no-range"
  | "format-no-size"
  | "format-no-match"
  | "format-too-late";

export interface ResizeResult {
  outcome: ResizeOutcome;
  /** What the organiser is told. */
  replyText: string;
  promoted: string[];
  demoted: string[];
}

const LIVE = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;

export async function resizeMatch(p: {
  matchId: string;
  /** Players a side asked for. 0 or less: none was said. */
  perSide: number;
  /** The organiser who asked (already checked by the caller). */
  actorUserId: string;
  /** Where it was asked, for the audit row ("web", "whatsapp", "hq"). */
  via: string;
  now?: Date;
}): Promise<ResizeResult> {
  const now = p.now ?? new Date();
  const match = await db.match.findUnique({
    where: { id: p.matchId },
    select: {
      id: true,
      date: true,
      status: true,
      maxPlayers: true,
      activity: {
        select: {
          id: true,
          name: true,
          orgId: true,
          minPlayers: true,
          maxPlayers: true,
          sport: { select: { playersPerTeam: true } },
          org: {
            select: {
              language: true,
              squadMode: true,
              listAnnouncer: true,
              paygPricePence: true,
              paymentTrackingEnabled: true,
              paymentCollectionEnabled: true,
              benchPickMode: true,
            },
          },
        },
      },
    },
  });
  const lang = normaliseLang(match?.activity.org?.language);
  const c = flexFormatCopy(lang);
  const none = (outcome: ResizeOutcome, replyText: string): ResizeResult => ({ outcome, replyText, promoted: [], demoted: [] });
  if (!match) return none("format-no-match", c.noMatch);
  if (!(LIVE as readonly string[]).includes(match.status) || match.date.getTime() <= now.getTime()) return none("format-too-late", c.tooLate);

  const activity = match.activity;
  const url = appUrl("/admin/activities");
  const range = playerRange({ minPlayers: activity.minPlayers ?? null, maxPlayers: activity.maxPlayers ?? null, playersPerTeam: activity.sport.playersPerTeam });
  const sides = sidesInRange(range);
  const day = weekdayLabel(lang, match.date);
  if (!(p.perSide > 0)) return none("format-no-size", c.noSize);
  if (p.perSide * 2 === match.maxPlayers) return none("format-unchanged", c.alreadyThat({ day, perSide: p.perSide }));
  if (sides.length <= 1) return none("format-no-range", c.noRange({ activityName: activity.name, perSide: activity.sport.playersPerTeam, url }));
  if (!sideAllowed(p.perSide, range)) return none("format-not-allowed", c.notAllowed({ activityName: activity.name, perSide: p.perSide, sides, url }));
  const newPlaces = p.perSide * 2;
  if (newPlaces === match.maxPlayers) return none("format-unchanged", c.alreadyThat({ day, perSide: p.perSide }));

  // A monthly club's running month: who the regulars are (never benched
  // before a non-regular) and, after, the slot numbers and the list.
  const monthly = activity.org?.squadMode === "monthly";
  const { loadMonthlyWeek, loadChoseBench, takeMonthlySlot, syncMonthlyWeek, renderWeekList, recordWeekListShown } = await import("./monthly-week");
  const week = monthly ? await loadMonthlyWeek(match.id) : null;
  const regulars = new Set((week?.members ?? []).filter((m) => m.kind === "regular" && !m.extra && !m.left).map((m) => m.userId));

  const organiserPick = activity.org?.benchPickMode === "organiser";

  type Row = { id: string; userId: string; status: "CONFIRMED" | "BENCH"; position: number; respondedAt: Date };
  const moved = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`team-slots:${match.id}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`monthly-week:${match.id}`}))`;
    // The size and the squad as they are under the locks.
    const [cur] = await tx.$queryRaw<Array<{ maxPlayers: number; status: string; date: Date }>>`
      SELECT "maxPlayers", status::text AS status, date FROM "Match" WHERE id = ${match.id} FOR UPDATE`;
    if (!cur) return { kind: "gone" as const };
    if (!(LIVE as readonly string[]).includes(cur.status) || cur.date.getTime() <= now.getTime()) return { kind: "gone" as const };
    const was = cur.maxPlayers;
    if (was === newPlaces) return { kind: "same" as const };
    const rows = await tx.$queryRaw<Row[]>`
      SELECT id, "userId", status::text AS status, position, "respondedAt"
        FROM "Attendance"
       WHERE "matchId" = ${match.id} AND status IN ('CONFIRMED', 'BENCH')
       FOR UPDATE`;
    const choseBench = rows.some((r) => r.status === "BENCH") ? await loadChoseBench(tx, match.id) : new Set<string>();
    const plan = planResize({
      newPlaces,
      rows: rows.map(
        (r): ResizeRow => ({
          userId: r.userId,
          status: r.status,
          position: r.position,
          joinedAt: r.respondedAt.getTime(),
          choseBench: choseBench.has(r.userId),
          regular: regulars.has(r.userId),
        }),
      ),
    });
    // Organiser pick: going up opens the places and moves nobody.
    const promoteWanted = organiserPick ? [] : plan.promote;
    await tx.match.update({ where: { id: match.id }, data: { maxPlayers: newPlaces } });
    const context = (note: string) => ({
      cause: "format-switch" as const,
      actorKind: "admin" as const,
      actorUserId: p.actorUserId,
      sourceRef: `${p.via}:resize:${was}-${newPlaces}`,
      note,
    });
    const done = { promote: [] as string[], demote: [] as string[] };
    for (const [ids, to, note, into] of [
      [promoteWanted, "CONFIRMED", `moved in from the bench: the match went up to ${newPlaces} places`, done.promote],
      [plan.demote, "BENCH", `moved to the bench: the match went down to ${newPlaces} places`, done.demote],
    ] as const) {
      for (const userId of ids) {
        const row = rows.find((r) => r.userId === userId)!;
        // Conditional on the status it was read with (the row is locked, so
        // this is belt and braces): a changed row is left as it is.
        const { count } = await tx.attendance.updateMany({ where: { id: row.id, status: row.status }, data: { status: to } });
        if (count === 0) continue;
        into.push(userId);
        await recordAttendanceEvent(
          tx,
          { matchId: match.id, userId, orgId: activity.orgId, fromStatus: row.status, toStatus: to, fromPosition: row.position, toPosition: row.position },
          context(note),
        );
      }
    }
    // The line-ups were for the old size.
    const { count: teamsCleared } = await tx.teamAssignment.deleteMany({ where: { matchId: match.id } });
    if (teamsCleared > 0) {
      await tx.match.updateMany({ where: { id: match.id, status: { in: ["TEAMS_GENERATED", "TEAMS_PUBLISHED"] } }, data: { status: "UPCOMING" } });
    }
    // Offers and bench asks for places that no longer exist are closed.
    const confirmedAfter = rows.filter((r) => r.status === "CONFIRMED").length + done.promote.length - done.demote.length;
    const free = Math.max(0, newPlaces - confirmedAfter);
    const open = await tx.benchSlotOffer.findMany({ where: { matchId: match.id, resolvedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true } });
    const surplus = open.slice(free).map((o) => o.id);
    if (surplus.length > 0) {
      await tx.benchSlotOffer.updateMany({ where: { id: { in: surplus }, resolvedAt: null }, data: { resolvedAt: now, outcome: "closed-format-switch" } });
    }
    await tx.pendingBenchConfirmation.updateMany({
      where: { matchId: match.id, resolvedAt: null, ...(free === 0 ? {} : { userId: { in: done.promote } }) },
      data: { resolvedAt: now, outcome: "format-switch" },
    });
    // The suggestion is never made for a size an organiser has just
    // decided against, nor again for the size just chosen: each size from
    // the new one up to the old is settled, for good.
    const lo = Math.min(newPlaces, was);
    const hi = Math.max(newPlaces, was);
    for (let places = lo + 2; places <= hi; places += 2) {
      const key = formatUpSettledKey(match.id, places);
      await tx.sentNotification.upsert({ where: { key }, create: { key, kind: "format-up-settled", matchId: match.id }, update: {} });
    }
    return { kind: "switched" as const, ...done, teamsCleared: teamsCleared > 0, was, free, confirmedAfter };
  });

  if (moved.kind === "gone") return none("format-too-late", c.tooLate);
  if (moved.kind === "same") return none("format-unchanged", c.alreadyThat({ day, perSide: p.perSide }));

  console.log(
    `[format-resize] org=${activity.orgId} match=${match.id} ${moved.was} -> ${newPlaces} places by ${p.via}; in ${moved.promote.length}, benched ${moved.demote.length}${moved.teamsCleared ? ", teams cleared" : ""}${organiserPick ? ", organisers pick" : ""}`,
  );

  // A monthly club: a player moved in takes a slot number, then the month's
  // bookkeeping (credits, who pays per game) catches up. Never throws.
  if (week) {
    for (const userId of moved.promote) await takeMonthlySlot(match.id, userId).catch((err) => console.error(`[format-resize] slot for ${userId} failed:`, err));
    await syncMonthlyWeek(match.id).catch((err) => console.error(`[format-resize] monthly sync failed (the poll retries):`, err));
  }

  // The DMs, held through the club's quiet hours.
  const quiet = await loadClubQuietHours(activity.orgId).catch(() => null);
  const sendAfter = adminNoticeSendAfter(now, quiet);
  const users = await db.user.findMany({
    where: { id: { in: [...moved.promote, ...moved.demote] } },
    select: { id: true, phoneNumber: true },
  });
  const phoneOf = new Map(users.map((u) => [u.id, u.phoneNumber]));
  const price =
    monthly && paymentMessagesOn(activity.org) ? paygPriceLabel(activity.org?.paygPricePence ?? null) : null;
  const dm = async (userId: string, text: string, kind: "in" | "bench") => {
    const phone = phoneOf.get(userId);
    if (!phone) return;
    await db.botJob.create({
      data: {
        orgId: activity.orgId,
        kind: "dm",
        phone: phone.replace(/^\+/, ""),
        text,
        matchId: match.id,
        aboutKey: `${match.id}:format-${kind}`,
        ...(sendAfter ? { sendAfter } : {}),
      },
    });
  };
  for (const userId of moved.promote) {
    await dm(userId, c.dmIn({ day, perSide: p.perSide, price: regulars.has(userId) ? null : price }), "in");
  }
  for (const userId of moved.demote) await dm(userId, c.dmBench({ day, perSide: p.perSide, places: newPlaces }), "bench");

  // The moved players' slot reactions on their IN messages.
  if (moved.promote.length + moved.demote.length > 0) {
    const { queueSlotEmojiRefresh } = await import("./bot-scheduler");
    await queueSlotEmojiRefresh(match.id).catch((err) => console.error(`[format-resize] slot reactions for ${match.id} failed:`, err));
  }

  // The new list.
  // Print-only names (player-display-name.ts never throws).
  const names = await loadPlayerNames(activity.orgId, [...moved.promote, ...moved.demote], lang);
  const nameOf = (id: string) => names.get(id)?.display ?? "?";
  await postNewList({
    matchId: match.id,
    orgId: activity.orgId,
    day,
    perSide: p.perSide,
    places: newPlaces,
    lang,
    listAnnouncer: activity.org?.listAnnouncer ?? null,
    monthly,
    sendAfter,
    now,
    renderWeekList,
    recordWeekListShown,
    loadMonthlyWeek,
  });

  return {
    outcome: "format-switched",
    replyText: c.switched({
      day,
      perSide: p.perSide,
      places: newPlaces,
      promoted: moved.promote.map(nameOf),
      demoted: moved.demote.map(nameOf),
      teamsCleared: moved.teamsCleared,
      pickOpen: organiserPick ? moved.free : 0,
    }),
    promoted: moved.promote,
    demoted: moved.demote,
  };
}

/**
 * What a switch to `perSide` would move, for the switch page's preview: the
 * same plan as the switch itself (a player who chose the bench is not
 * moved in; an organiser-pick club moves nobody in; monthly regulars are
 * benched last). Counts only; nothing is written.
 */
export async function previewResize(matchId: string, perSide: number): Promise<{ promote: number; demote: number }> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: {
      activity: { select: { org: { select: { squadMode: true, benchPickMode: true } } } },
      attendances: { where: { status: { in: ["CONFIRMED", "BENCH"] } }, select: { userId: true, status: true, position: true, respondedAt: true } },
    },
  });
  if (!match || !(perSide > 0)) return { promote: 0, demote: 0 };
  const { loadMonthlyWeek, loadChoseBench } = await import("./monthly-week");
  const week = match.activity.org?.squadMode === "monthly" ? await loadMonthlyWeek(matchId) : null;
  const regulars = new Set((week?.members ?? []).filter((m) => m.kind === "regular" && !m.extra && !m.left).map((m) => m.userId));
  const chose = match.attendances.some((a) => a.status === "BENCH") ? await loadChoseBench(db, matchId) : new Set<string>();
  const plan = planResize({
    newPlaces: perSide * 2,
    rows: match.attendances.map((a) => ({
      userId: a.userId,
      status: a.status as "CONFIRMED" | "BENCH",
      position: a.position,
      joinedAt: a.respondedAt.getTime(),
      choseBench: chose.has(a.userId),
      regular: regulars.has(a.userId),
    })),
  });
  return { promote: match.activity.org?.benchPickMode === "organiser" ? 0 : plan.promote.length, demote: plan.demote.length };
}

/**
 * The list after a switch, held through the club's quiet hours (as the DMs
 * are). A monthly club: the month's week list once its regulars are on the
 * match, and nothing before (its list is the month's, and goes out when
 * they are). A weekly club: the roster, with the marker the chases read so
 * the same squad is not listed again inside three hours; and the
 * `squad-locked` claim set when the squad is full now (so the "Squad
 * complete" post does not repeat this list) or cleared when it is not (so
 * the next fill is announced), as the rolling squad's seed does.
 */
async function postNewList(a: {
  matchId: string;
  orgId: string;
  day: string;
  perSide: number;
  places: number;
  lang: "en" | "tr";
  listAnnouncer: string | null;
  monthly: boolean;
  sendAfter: Date | null;
  now: Date;
  renderWeekList: typeof import("./monthly-week").renderWeekList;
  recordWeekListShown: typeof import("./monthly-week").recordWeekListShown;
  loadMonthlyWeek: typeof import("./monthly-week").loadMonthlyWeek;
}): Promise<void> {
  const c = flexFormatCopy(a.lang);
  let text: string;
  let after: (() => Promise<void>) | null = null;
  if (a.monthly) {
    const week = await a.loadMonthlyWeek(a.matchId);
    if (!week || !week.seeded) return;
    const r = await a.renderWeekList(week);
    text = r.text;
    // The group has seen this list: the scheduler does not post it again.
    after = () => a.recordWeekListShown(a.matchId, r.hash, "group-message");
  } else {
    const rows = await db.attendance.findMany({
      where: { matchId: a.matchId, status: { in: ["CONFIRMED", "BENCH"] } },
      select: { userId: true, status: true, position: true, user: { select: { name: true } } },
      orderBy: { position: "asc" },
    });
    const shown = await loadPlayerNames(a.orgId, rows.map((r) => r.userId), a.lang);
    const label = (r: (typeof rows)[number]) => shown.get(r.userId)?.display ?? r.user.name ?? "?";
    const playing = rows.filter((r) => r.status === "CONFIRMED");
    const bench = rows.filter((r) => r.status === "BENCH");
    text =
      `${c.rosterHeader({ day: a.day, perSide: a.perSide, places: a.places })}\n\n` +
      `${c.rosterPlaying({ confirmed: playing.length, places: a.places })}\n` +
      (playing.length ? playing.map((r, i) => `${i + 1}. ${label(r)}`).join("\n") : c.rosterNobody) +
      (bench.length ? `\n\n${c.rosterBench}\n` + bench.map((r, i) => `${i + 1}. ${label(r)}`).join("\n") : "");
    const lockedKey = `${a.matchId}:squad-locked`;
    const full = playing.length >= a.places;
    const fingerprint = squadFingerprint({ confirmedUserIds: playing.map((r) => r.userId), benchUserIds: bench.map((r) => r.userId), maxPlayers: a.places });
    after = async () => {
      if (full) {
        await db.sentNotification.upsert({ where: { key: lockedKey }, create: { key: lockedKey, kind: "group-message", matchId: a.matchId }, update: {} });
      } else {
        await db.sentNotification.deleteMany({ where: { key: lockedKey } });
      }
      await db.sentNotification.create({ data: { key: rosterShownKey(a.matchId, fingerprint, a.now), kind: ROSTER_SHOWN_KIND, matchId: a.matchId } });
    };
  }
  if (organisersAnnounce({ listAnnouncer: a.listAnnouncer })) {
    await sendAdminNotice({ orgId: a.orgId, text: buildOrganiserRelay(text, a.lang) });
    return;
  }
  await db.botJob.create({ data: { orgId: a.orgId, kind: "group", text, matchId: a.matchId, ...(a.sendAfter ? { sendAfter: a.sendAfter } : {}) } });
  await after?.().catch((err) => console.error(`[format-resize] list bookkeeping for ${a.matchId} failed:`, err));
}
