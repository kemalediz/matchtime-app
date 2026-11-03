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
 * WHAT IT DOES, in one transaction under the week's lock (the same advisory
 * key the monthly slot writer takes, so a monthly fill-in cannot take a
 * slot halfway through):
 *   - `Match.maxPlayers` becomes the new places. The match stays on its own
 *     Activity: no second match, no new kickoff (see flex-format-rules.ts
 *     for why this is not `switchMatchFormat`).
 *   - UP: the bench moves in, in bench order (`planResize`), except a player
 *     who asked to be on the bench. Each gets a DM that he is in, and pays as
 *     he goes (for a monthly club, the PAYG price, named only when the club
 *     takes payments).
 *   - DOWN: the squad above the new size goes to the bench, the last to join
 *     first, a monthly club's regulars after every non-regular. Each is told
 *     by DM.
 *   - Line-ups already made are cleared (they were for the old size).
 *   - Open bench offers beyond the places now free are closed.
 * Then the new list is posted: the month's week list for a monthly club,
 * the roster for a weekly one, to the organisers instead when the club's
 * organisers announce the list (`list-announcer.ts`).
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
import { formatUpKey, planResize, playerRange, sideAllowed, sidesInRange, type ResizeRow } from "./flex-format-rules";

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

  const moved = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`monthly-week:${match.id}`}))`;
    // The places as they are under the lock: a second switch racing this
    // one has either finished (and this one recuts from its result) or waits.
    const was = (await tx.match.findUnique({ where: { id: match.id }, select: { maxPlayers: true } }))?.maxPlayers ?? match.maxPlayers;
    const rows = await tx.attendance.findMany({
      where: { matchId: match.id, status: { in: ["CONFIRMED", "BENCH"] } },
      select: { id: true, userId: true, status: true, position: true, respondedAt: true },
    });
    const choseBench = rows.some((r) => r.status === "BENCH") ? await loadChoseBench(tx, match.id) : new Set<string>();
    const plan = planResize({
      newPlaces,
      rows: rows.map(
        (r): ResizeRow => ({
          userId: r.userId,
          status: r.status as ResizeRow["status"],
          position: r.position,
          joinedAt: r.respondedAt.getTime(),
          choseBench: choseBench.has(r.userId),
          regular: regulars.has(r.userId),
        }),
      ),
    });
    await tx.match.update({ where: { id: match.id }, data: { maxPlayers: newPlaces } });
    const context = (note: string) => ({
      cause: "format-switch" as const,
      actorKind: "admin" as const,
      actorUserId: p.actorUserId,
      sourceRef: `${p.via}:resize:${was}-${newPlaces}`,
      note,
    });
    for (const [ids, to, note] of [
      [plan.promote, "CONFIRMED", `moved in from the bench: the match went up to ${newPlaces} places`],
      [plan.demote, "BENCH", `moved to the bench: the match went down to ${newPlaces} places`],
    ] as const) {
      for (const userId of ids) {
        const row = rows.find((r) => r.userId === userId)!;
        await tx.attendance.update({ where: { id: row.id }, data: { status: to } });
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
    const confirmedAfter = rows.filter((r) => r.status === "CONFIRMED").length + plan.promote.length - plan.demote.length;
    const free = Math.max(0, newPlaces - confirmedAfter);
    const open = await tx.benchSlotOffer.findMany({ where: { matchId: match.id, resolvedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true } });
    const surplus = open.slice(free).map((o) => o.id);
    if (surplus.length > 0) {
      await tx.benchSlotOffer.updateMany({ where: { id: { in: surplus }, resolvedAt: null }, data: { resolvedAt: now, outcome: "closed-format-switch" } });
    }
    await tx.pendingBenchConfirmation.updateMany({
      where: { matchId: match.id, resolvedAt: null, ...(free === 0 ? {} : { userId: { in: plan.promote } }) },
      data: { resolvedAt: now, outcome: "format-switch" },
    });
    // The suggestion is never made for a size an organiser has just
    // decided against, nor again for the size just chosen: each size from
    // the new one up to the old is marked as suggested.
    const lo = Math.min(newPlaces, was);
    const hi = Math.max(newPlaces, was);
    for (let places = lo + 2; places <= hi; places += 2) {
      const key = formatUpKey(match.id, places);
      await tx.sentNotification.upsert({ where: { key }, create: { key, kind: "format-up-settled", matchId: match.id }, update: {} });
    }
    return { promote: plan.promote, demote: plan.demote, teamsCleared: teamsCleared > 0, was };
  });

  console.log(
    `[format-resize] org=${activity.orgId} match=${match.id} ${moved.was} -> ${newPlaces} places by ${p.via}; in ${moved.promote.length}, benched ${moved.demote.length}${moved.teamsCleared ? ", teams cleared" : ""}`,
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

  // The new list.
  // Print-only names (player-display-name.ts never throws).
  const names = await loadPlayerNames(activity.orgId, [...moved.promote, ...moved.demote], lang);
  const nameOf = (id: string) => names.get(id)?.display ?? "?";
  await postNewList({ matchId: match.id, orgId: activity.orgId, day, perSide: p.perSide, places: newPlaces, lang, listAnnouncer: activity.org?.listAnnouncer ?? null, monthly: week !== null, renderWeekList, recordWeekListShown, loadMonthlyWeek });

  return {
    outcome: "format-switched",
    replyText: c.switched({ day, perSide: p.perSide, places: newPlaces, promoted: moved.promote.map(nameOf), demoted: moved.demote.map(nameOf), teamsCleared: moved.teamsCleared }),
    promoted: moved.promote,
    demoted: moved.demote,
  };
}

/** The list after a switch: the month's week list, or the weekly roster. */
async function postNewList(a: {
  matchId: string;
  orgId: string;
  day: string;
  perSide: number;
  places: number;
  lang: "en" | "tr";
  listAnnouncer: string | null;
  monthly: boolean;
  renderWeekList: typeof import("./monthly-week").renderWeekList;
  recordWeekListShown: typeof import("./monthly-week").recordWeekListShown;
  loadMonthlyWeek: typeof import("./monthly-week").loadMonthlyWeek;
}): Promise<void> {
  const c = flexFormatCopy(a.lang);
  let text: string;
  let shownHash: string | null = null;
  const week = a.monthly ? await a.loadMonthlyWeek(a.matchId) : null;
  if (week && week.seeded) {
    const r = await a.renderWeekList(week);
    text = r.text;
    shownHash = r.hash;
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
  }
  if (organisersAnnounce({ listAnnouncer: a.listAnnouncer })) {
    await sendAdminNotice({ orgId: a.orgId, text: buildOrganiserRelay(text, a.lang) });
    return;
  }
  await db.botJob.create({ data: { orgId: a.orgId, kind: "group", text, matchId: a.matchId } });
  // The group has seen this list: the scheduler does not post it again.
  if (shownHash) await a.recordWeekListShown(a.matchId, shownHash, "group-message");
}
