/**
 * Monthly squad, slice 3: the month opens and people sign up, the
 * database side (2026-10-06).
 * Plan: MDs/monthly-squad-plan-2026-10-05.md, sections 4.1 and 6.2.
 *
 * For a club on `squadMode = "monthly"` ONLY. Every entry point reads the
 * club's mode first and returns before any other query or write for a
 * club on "weekly" (Sutton FC and every club before this).
 *
 *   openDueMonthLists(orgId)   N days before a month's first game, 10:00
 *                              London: the month's matches exist, the
 *                              month is created "open" and this month's
 *                              regulars are carried onto it. Called by the
 *                              due-posts poll. Once per club-month.
 *   advanceSignupMonths(orgId) a day later sign-up ends: the month goes
 *                              "running" and the weekly flow (slice 5)
 *                              takes it from there.
 *   applySignup()              ONE person's choice (in, PAYG, out), from
 *                              any door, under the club-month's lock.
 *   handleSignupPaste()        door 1: a pasted list. Only the sender's
 *                              own line; never creates a player.
 *   handleSignupMessage()      door 2: "IN FOR NOVEMBER", or the bare
 *                              word as a reply to the list.
 *   signupListPosts()          the list post, for `computeDuePosts`.
 *
 * The rules are pure and live in `month-signup-rules.ts`. Nothing here
 * calls a model. A month a club started part-way through (plan 4.5) has
 * no sign-up: it is "running" from the start and never read as "open".
 */
import { db } from "./db";
import { sendAdminNotice } from "./admin-channel";
import { appUrl } from "./app-url";
import { cancelAttendance, registerAttendance } from "./attendance";
import { isClubOperational } from "./club-approval-state";
import { formatLondon, londonDateTimeToUtc } from "./london-time";
import { hasMatchForSlot, isSameRecurringFixture, type RecurringFixtureKey } from "./match-slot";
import { parseMonthlyList } from "./monthly-list";
import { weekListHash } from "./monthly-week-rules";
import { adminNoticeSendAfter } from "./rolling-squad-rules";
import {
  buildSignupListPost,
  buildSignupLockedDm,
  buildSignupPasteOthersDm,
  buildSignupUnknownDaysDm,
  buildSignupWaitingAdminNotice,
  buildSignupWaitingDm,
  signupPasteResidual,
} from "./month-signup-copy";
import {
  WAITING_NOTE,
  buildSignupList,
  decideSignup,
  decideSignupListPost,
  firstKickoffOf,
  isDaytime,
  listOpenDue,
  listOpensAt,
  monthKickoffs,
  nextMonthStart,
  planCarryOver,
  previousMonthStart,
  readSignupMessage,
  reconcileSignupPaste,
  signupEndsAt,
  signupPasteShowsSameList,
  type MonthMatchDay,
  type SignupChoice,
  type SignupMember,
  type SignupNotAdded,
  type SignupOutcome,
  type SignupPaidClaim,
  type SignupRosterMember,
} from "./month-signup-rules";
import { londonMonthStart, monthStartToDate, normaliseSquadMode } from "./squad-month-rules";

const LIVE = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;
const HOUR_MS = 60 * 60 * 1000;

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/** Every once-only key of the sign-up starts with this, so one sweep can
 *  clear the old ones. Slice 5's list keys are `<matchId>:month-list:`. */
export function signupKeyPrefix(orgId: string): string {
  return `org-${orgId}:msu:`;
}

/** The key prefix of every "the group has seen this sign-up list" row. */
export function signupListKeyPrefix(orgId: string, monthId: string): string {
  return `${signupKeyPrefix(orgId)}list:${monthId}:`;
}

/** Claim a once-only key. False when it was already claimed. */
async function claimOnce(key: string, kind: string): Promise<boolean> {
  try {
    await db.sentNotification.create({ data: { key, kind } });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/** One writer at a time per club-month: members, slots, money. Slice 4's
 *  pricing and payment writes take this same lock. */
export async function lockMonth(tx: Tx, monthId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`squad-month:${monthId}`}))`;
}

// ── Loading ────────────────────────────────────────────────────────────

export interface SignupMonth {
  id: string;
  orgId: string;
  activityId: string;
  activityName: string;
  /** "2026-11-01". */
  monthStart: string;
  /** 1 to 12. */
  monthNumber: number;
  status: string;
  /** Sign-up is open: the month's status is "open". */
  open: boolean;
  listOpenedAt: Date | null;
  /** The month's games on the fixture's weekday, from the calendar. */
  kickoffs: Date[];
  firstKickoff: Date;
  /** When sign-up ends. Null for a month with no sign-up (started part-way). */
  endsAt: Date | null;
  /** The regular places: the format's squad size. */
  maxRegulars: number;
  /** The month's matches that exist and are not cancelled, by London day. */
  matches: Array<MonthMatchDay & { date: Date; status: string }>;
  /** Everybody on the month who is still in the club, OUT ones included. */
  members: Array<SignupMember & { tier: string }>;
  /** A day in the month the regulars were carried over from, or null. */
  carriedFrom: Date | null;
  language: string | null;
}

const MONTH_SELECT = {
  id: true,
  orgId: true,
  activityId: true,
  monthStart: true,
  status: true,
  listOpenedAt: true,
  activity: {
    select: { name: true, venue: true, dayOfWeek: true, time: true, sport: { select: { playersPerTeam: true } } },
  },
  org: { select: { language: true } },
  members: {
    orderBy: { createdAt: "asc" },
    select: {
      userId: true,
      kind: true,
      tier: true,
      slot: true,
      note: true,
      leftAt: true,
      source: true,
      paidAt: true,
      paidClaimedAt: true,
      paygMatchIds: true,
      user: { select: { name: true } },
    },
  },
} as const;

/** The matches of one fixture in one London month, cancelled ones left out. */
async function loadMonthMatches(
  client: Pick<Tx, "match">,
  fixture: RecurringFixtureKey,
  monthStart: string,
): Promise<Array<MonthMatchDay & { date: Date; status: string }>> {
  const from = londonDateTimeToUtc(monthStart, "00:00");
  const to = londonDateTimeToUtc(nextMonthStart(monthStart), "00:00");
  const rows = await client.match.findMany({
    where: { activity: { orgId: fixture.orgId }, isHistorical: false, status: { not: "CANCELLED" }, date: { gte: from, lt: to } },
    select: { id: true, date: true, status: true, activity: { select: { orgId: true, venue: true, dayOfWeek: true } } },
    orderBy: { date: "asc" },
  });
  return rows
    .filter((m) => isSameRecurringFixture(m.activity, fixture))
    .map((m) => ({ matchId: m.id, day: Number(formatLondon(m.date, "d")), date: m.date, status: m.status }));
}

type MonthRow = NonNullable<Awaited<ReturnType<typeof loadMonthRow>>>;
function loadMonthRow(monthId: string) {
  return db.squadMonth.findUnique({ where: { id: monthId }, select: MONTH_SELECT });
}

async function toSignupMonth(row: MonthRow): Promise<SignupMonth | null> {
  const monthStart = row.monthStart.toISOString().slice(0, 10);
  const kickoffs = monthKickoffs(monthStart, row.activity.dayOfWeek, row.activity.time);
  if (kickoffs.length === 0) return null;
  const fixture = { orgId: row.orgId, venue: row.activity.venue, dayOfWeek: row.activity.dayOfWeek };
  const ids = row.members.map((m) => m.userId);
  const [matches, here] = await Promise.all([
    loadMonthMatches(db, fixture, monthStart),
    ids.length === 0
      ? Promise.resolve([])
      : db.membership.findMany({ where: { orgId: row.orgId, userId: { in: ids }, leftAt: null, user: { isActive: true } }, select: { userId: true } }),
  ]);
  const inClub = new Set(here.map((h) => h.userId));
  return {
    id: row.id,
    orgId: row.orgId,
    activityId: row.activityId,
    activityName: row.activity.name,
    monthStart,
    monthNumber: Number(monthStart.slice(5, 7)),
    status: row.status,
    open: row.status === "open",
    listOpenedAt: row.listOpenedAt,
    kickoffs,
    firstKickoff: kickoffs[0],
    endsAt: row.listOpenedAt ? signupEndsAt(row.listOpenedAt, kickoffs[0]) : null,
    maxRegulars: row.activity.sport.playersPerTeam * 2,
    matches,
    // Somebody who has left the group is not on the list. Their row stays
    // (it may know of money); it is simply not read here.
    members: row.members
      .filter((m) => inClub.has(m.userId))
      .map((m) => ({
        userId: m.userId,
        name: m.user.name ?? "",
        kind: m.kind === "payg" ? "payg" : "regular",
        tier: m.tier,
        slot: m.slot,
        waiting: m.kind === "payg" && m.note === WAITING_NOTE,
        out: m.leftAt !== null,
        paid: m.paidAt ? "confirmed" : m.paidClaimedAt ? "claimed" : "none",
        paygMatchIds: m.paygMatchIds,
      })),
    carriedFrom: row.members.some((m) => m.source === "carry-over") ? monthStartToDate(previousMonthStart(monthStart)) : null,
    language: row.org.language,
  };
}

/** One month, as the sign-up sees it. Null for a club on "weekly". */
export async function loadSignupMonth(monthId: string): Promise<SignupMonth | null> {
  const row = await loadMonthRow(monthId);
  if (!row) return null;
  const org = await db.organisation.findUnique({ where: { id: row.orgId }, select: { squadMode: true } });
  if (!org || normaliseSquadMode(org.squadMode) !== "monthly") return null;
  return toSignupMonth(row);
}

/**
 * The months of a club that somebody can still JOIN: this London month or
 * the next, not closed, and its first game not kicked off yet. At most a
 * handful of rows. The caller has already checked the club is monthly.
 */
export async function loadJoinableMonths(orgId: string, now: Date = new Date()): Promise<SignupMonth[]> {
  const current = londonMonthStart(now);
  const rows = await db.squadMonth.findMany({
    where: {
      orgId,
      status: { in: ["open", "priced", "running"] },
      monthStart: { in: [monthStartToDate(current), monthStartToDate(nextMonthStart(current))] },
    },
    select: MONTH_SELECT,
    orderBy: { monthStart: "asc" },
  });
  const out: SignupMonth[] = [];
  for (const row of rows) {
    const m = await toSignupMonth(row);
    if (m && now.getTime() < m.firstKickoff.getTime()) out.push(m);
  }
  return out;
}

// ── The list opens (plan 4.1) ──────────────────────────────────────────

/**
 * Open every month list of a club that is due: N days before the month's
 * first game, from 10:00 London, in waking hours. For this London month
 * (a club that switched to monthly before its first game) and the next.
 *
 * One month per recurring FIXTURE, not per Activity: a club with two
 * formats of the same weekly game has one list. The Activity is the one
 * the month before used, else the fixture's oldest active one.
 *
 * Idempotent under retries and concurrent polls: the unique key (club,
 * fixture, month) decides, and the loser writes nothing.
 */
export async function openDueMonthLists(orgId: string, now: Date = new Date()): Promise<string[]> {
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { squadMode: true, monthListOpensDaysBefore: true, approvalStatus: true, dormantAt: true, billingStatus: true },
  });
  if (!org || normaliseSquadMode(org.squadMode) !== "monthly" || !isClubOperational(org)) return [];
  if (!isDaytime(now)) return [];

  const current = londonMonthStart(now);
  const next = nextMonthStart(current);
  const [activities, months] = await Promise.all([
    db.activity.findMany({
      where: { orgId, isActive: true },
      select: { id: true, venue: true, dayOfWeek: true, time: true, deadlineHours: true, sport: { select: { playersPerTeam: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.squadMonth.findMany({
      where: { orgId, monthStart: { in: [previousMonthStart(current), current, next].map(monthStartToDate) } },
      select: { id: true, monthStart: true, activityId: true, activity: { select: { venue: true, dayOfWeek: true } } },
    }),
  ]);
  const fixtureKey = (a: { venue: string; dayOfWeek: number }) => `${a.dayOfWeek}|${a.venue}`;
  const monthsOf = (monthStart: string) => months.filter((m) => m.monthStart.toISOString().slice(0, 10) === monthStart);

  const opened: string[] = [];
  for (const monthStart of [current, next]) {
    const have = new Set(monthsOf(monthStart).map((m) => fixtureKey(m.activity)));
    const before = monthsOf(previousMonthStart(monthStart));
    const done = new Set<string>();
    for (const a of activities) {
      const key = fixtureKey(a);
      if (have.has(key) || done.has(key)) continue;
      done.add(key);
      // The Activity the month before used, when it is still active.
      const prior = before.find((m) => fixtureKey(m.activity) === key);
      const activity = (prior && activities.find((x) => x.id === prior.activityId)) || a;
      const first = firstKickoffOf(monthStart, activity.dayOfWeek, activity.time);
      if (!first) continue;
      if (!listOpenDue({ now, opensAt: listOpensAt(first, org.monthListOpensDaysBefore), firstKickoff: first })) continue;
      try {
        const id = await openMonthList({ orgId, activity, monthStart, previousMonthId: prior?.id ?? null, now });
        if (id) opened.push(id);
      } catch (err) {
        // One fixture's failure must not stop the others; the transaction
        // rolled back, so the next poll retries.
        console.error(`[month-signup] opening ${monthStart} for activity ${activity.id} failed:`, err);
      }
    }
  }
  return opened;
}

async function openMonthList(args: {
  orgId: string;
  activity: { id: string; venue: string; dayOfWeek: number; time: string; deadlineHours: number; sport: { playersPerTeam: number } };
  monthStart: string;
  previousMonthId: string | null;
  now: Date;
}): Promise<string | null> {
  const { orgId, activity, monthStart, now } = args;
  const fixture = { orgId, venue: activity.venue, dayOfWeek: activity.dayOfWeek };
  const maxRegulars = activity.sport.playersPerTeam * 2;

  // Who is carried over: read before the transaction, written inside it.
  let carried: ReturnType<typeof planCarryOver> = [];
  if (args.previousMonthId) {
    const previous = await db.squadMonthMember.findMany({
      where: { monthId: args.previousMonthId },
      select: { userId: true, kind: true, tier: true, slot: true, leftAt: true },
    });
    const here = new Set(
      previous.length === 0
        ? []
        : (
            await db.membership.findMany({
              where: { orgId, userId: { in: previous.map((p) => p.userId) }, leftAt: null, user: { isActive: true } },
              select: { userId: true },
            })
          ).map((m) => m.userId),
    );
    carried = planCarryOver({
      previous: previous.map((p) => ({ userId: p.userId, kind: p.kind, tier: p.tier, slot: p.slot, left: p.leftAt !== null, here: here.has(p.userId) })),
      maxRegulars,
    });
  }

  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`squad-month-open:${orgId}:${monthStart}`}))`;
      // Under the lock: is there a month for this FIXTURE already (another
      // format's Activity counts)?
      const existing = await tx.squadMonth.findMany({
        where: { orgId, monthStart: monthStartToDate(monthStart) },
        select: { activity: { select: { venue: true, dayOfWeek: true } } },
      });
      if (existing.some((m) => isSameRecurringFixture({ orgId, ...m.activity }, fixture))) return null;

      // The month's matches exist before the list goes out (plan 4.1), so a
      // PAYG player can name a date. Future matches stay silent: only a
      // fixture's next match is ever posted about.
      const have = await loadMonthMatches(tx, fixture, monthStart);
      const cancelled = await tx.match.findMany({
        where: {
          activity: { orgId },
          status: "CANCELLED",
          date: { gte: londonDateTimeToUtc(monthStart, "00:00"), lt: londonDateTimeToUtc(nextMonthStart(monthStart), "00:00") },
        },
        select: { date: true, activity: { select: { orgId: true, venue: true, dayOfWeek: true } } },
      });
      const taken = [...have.map((m) => ({ ...fixture, instant: m.date })), ...cancelled.map((m) => ({ ...m.activity, instant: m.date }))];
      let games = have.length;
      for (const kickoff of monthKickoffs(monthStart, activity.dayOfWeek, activity.time)) {
        if (kickoff.getTime() <= now.getTime()) continue;
        if (hasMatchForSlot({ ...fixture, instant: kickoff }, taken)) continue;
        await tx.match.create({
          data: {
            activityId: activity.id,
            date: kickoff,
            maxPlayers: maxRegulars,
            attendanceDeadline: new Date(kickoff.getTime() - activity.deadlineHours * HOUR_MS),
          },
        });
        games++;
      }

      const month = await tx.squadMonth.create({
        data: { orgId, activityId: activity.id, monthStart: monthStartToDate(monthStart), status: "open", gamesScheduled: games, listOpenedAt: now },
        select: { id: true },
      });
      if (carried.length > 0) {
        await tx.squadMonthMember.createMany({
          data: carried.map((c) => ({
            monthId: month.id,
            userId: c.userId,
            kind: c.waiting ? "payg" : "regular",
            tier: c.tier,
            slot: c.slot,
            gamesCovered: c.waiting ? 0 : games,
            note: c.waiting ? WAITING_NOTE : null,
            source: "carry-over",
            joinedAt: now,
          })),
        });
      }
      console.log(`[month-signup] opened ${monthStart} for ${orgId}/${activity.id}: ${carried.length} carried over, ${games} games`);
      return month.id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

/**
 * Sign-up has ended for these months: they go "running", and from the
 * next poll the weekly flow (slice 5) seeds, lists and credits them. A
 * compare-and-set on the status, so two polls flip a month once.
 */
export async function advanceSignupMonths(orgId: string, now: Date = new Date()): Promise<string[]> {
  const open = await db.squadMonth.findMany({
    where: { orgId, status: "open", listOpenedAt: { not: null } },
    select: { id: true, monthStart: true, listOpenedAt: true, activity: { select: { dayOfWeek: true, time: true } } },
  });
  const ended: string[] = [];
  for (const m of open) {
    const first = firstKickoffOf(m.monthStart.toISOString().slice(0, 10), m.activity.dayOfWeek, m.activity.time);
    // A fixture whose time can no longer be read: end sign-up rather than
    // leave the month open for ever.
    if (first && now.getTime() < signupEndsAt(m.listOpenedAt!, first).getTime()) continue;
    const res = await db.squadMonth.updateMany({ where: { id: m.id, status: "open" }, data: { status: "running" } });
    if (res.count > 0) ended.push(m.id);
  }
  return ended;
}

/**
 * The due-posts poll's one call for the sign-up, BEFORE the weekly sweep
 * (so a month whose sign-up has just ended is seeded in the same poll).
 * A club on "weekly" returns after one read. Never throws.
 */
export async function sweepMonthSignups(orgId: string, now: Date = new Date()): Promise<void> {
  try {
    const org = await db.organisation.findUnique({
      where: { id: orgId },
      select: { squadMode: true, approvalStatus: true, dormantAt: true, billingStatus: true },
    });
    if (!org || normaliseSquadMode(org.squadMode) !== "monthly" || !isClubOperational(org)) return;
    await openDueMonthLists(orgId, now);
    await advanceSignupMonths(orgId, now);
  } catch (err) {
    console.error(`[month-signup] sweep for ${orgId} failed (the next poll retries):`, err);
  }
}

// ── One person's choice ────────────────────────────────────────────────

export type SignupSource = "paste" | "reply" | "page" | "admin";

export type ApplySignupResult =
  | { ok: true; changed: boolean; locked: boolean; outcome: SignupOutcome; unknownDays: number[] }
  | { ok: false; error: "not-found" | "closed" | "not-a-member" };

/**
 * Write one person's choice for a month: IN (a regular), PAYG (with or
 * without dates) or OUT. Every door ends here.
 *
 *  - only for a club on "monthly", a month that is not closed, and (for a
 *    player's own choice) before the month's first game: joining a month
 *    under way is the organiser's;
 *  - the person must be a current player of the club. Nobody is created;
 *  - under the club-month's advisory lock, on rows read inside it, so two
 *    people taking the last place at once get one place and one wait;
 *  - a row is never deleted. OUT sets `leftAt` and keeps what the row
 *    knows of money; nothing here writes a paid field;
 *  - somebody who says they have paid is not moved by their own message.
 */
export async function applySignup(args: {
  monthId: string;
  userId: string;
  choice: SignupChoice;
  days?: number[];
  source: SignupSource;
  actorUserId: string | null;
  /** An OWNER or ADMIN changing somebody on /admin/months. */
  byOrganiser?: boolean;
  now?: Date;
}): Promise<ApplySignupResult> {
  const now = args.now ?? new Date();
  const month = await loadSignupMonth(args.monthId);
  if (!month || month.status === "closed") return { ok: false, error: month ? "closed" : "not-found" };
  if (!args.byOrganiser && now.getTime() >= month.firstKickoff.getTime()) return { ok: false, error: "closed" };
  const member = await db.membership.findFirst({
    where: { orgId: month.orgId, userId: args.userId, leftAt: null, user: { isActive: true } },
    select: { user: { select: { name: true, phoneNumber: true } } },
  });
  if (!member) return { ok: false, error: "not-a-member" };

  const gamesLeft = month.kickoffs.filter((k) => k.getTime() > now.getTime()).length;
  const decision = await db.$transaction(async (tx) => {
    await lockMonth(tx, month.id);
    const rows = await tx.squadMonthMember.findMany({
      where: { monthId: month.id },
      select: { id: true, userId: true, kind: true, slot: true, note: true, leftAt: true, paidAt: true, paidClaimedAt: true, paygMatchIds: true },
    });
    const view = (r: (typeof rows)[number]): SignupMember => ({
      userId: r.userId,
      name: "",
      kind: r.kind === "payg" ? "payg" : "regular",
      slot: r.slot,
      waiting: r.kind === "payg" && r.note === WAITING_NOTE,
      out: r.leftAt !== null,
      paid: r.paidAt ? "confirmed" : r.paidClaimedAt ? "claimed" : "none",
      paygMatchIds: r.paygMatchIds,
    });
    // Somebody who has left the GROUP no longer holds a number. Read
    // inside the lock, like the rows: a place is only ever given once.
    const inClub = new Set(
      (
        await tx.membership.findMany({
          where: { orgId: month.orgId, userId: { in: rows.map((r) => r.userId) }, leftAt: null, user: { isActive: true } },
          select: { userId: true },
        })
      ).map((m) => m.userId),
    );
    const mine = rows.find((r) => r.userId === args.userId) ?? null;
    const d = decideSignup({
      choice: args.choice,
      days: args.days ?? [],
      existing: mine ? view(mine) : null,
      others: rows.filter((r) => r.userId !== args.userId && inClub.has(r.userId)).map(view),
      maxRegulars: month.maxRegulars,
      matches: month.matches,
      byOrganiser: args.byOrganiser,
    });
    if (d.kind !== "write") return d;
    const regular = d.row.kind === "regular";
    const data = {
      kind: d.row.kind,
      slot: d.row.slot,
      paygMatchIds: d.row.paygMatchIds,
      note: d.row.waiting ? WAITING_NOTE : null,
      leftAt: d.row.out ? now : null,
    };
    // The number is theirs alone: a regular who has left the group and
    // still carries it gives it up (their row, and its money, stay).
    if (regular && d.row.slot !== null) {
      await tx.squadMonthMember.updateMany({
        where: { monthId: month.id, slot: d.row.slot, userId: { not: args.userId, notIn: [...inClub] } },
        data: { slot: null },
      });
    }
    if (!mine) {
      await tx.squadMonthMember.create({
        data: { monthId: month.id, userId: args.userId, ...data, gamesCovered: regular ? gamesLeft : 0, source: args.source, joinedAt: now },
      });
    } else if (d.row.out) {
      // OUT: only the flag. Everything the row knows stays as it was.
      await tx.squadMonthMember.update({ where: { id: mine.id }, data: { leftAt: now } });
    } else {
      const wasRegular = mine.kind === "regular" && mine.leftAt === null;
      await tx.squadMonthMember.update({
        where: { id: mine.id },
        data: {
          ...data,
          // A new regular covers the games still to play. A regular who
          // stays one keeps what they had.
          ...(regular ? (wasRegular ? {} : { gamesCovered: gamesLeft }) : { gamesCovered: 0, creditsApplied: 0, amountDuePence: null }),
        },
      });
    }
    return d;
  });

  if (decision.kind === "none") return { ok: true, changed: false, locked: false, outcome: decision.outcome, unknownDays: [] };

  const phone = member.user.phoneNumber?.replace(/^\+/, "") ?? null;
  const sendAfter = adminNoticeSendAfter(now);
  const day = formatLondon(now, "yyyy-MM-dd");
  /** A DM to the person themselves, once per key, never 22:00 to 07:59. */
  const tell = async (key: string, text: string): Promise<void> => {
    // The page says it on the page; an organiser's change is the organiser's to pass on.
    if (!phone || args.source === "page" || args.source === "admin") return;
    try {
      if (await claimOnce(`${signupKeyPrefix(month.orgId)}${key}`, "signup-dm")) {
        await db.botJob.create({ data: { orgId: month.orgId, kind: "dm", phone, text, ...(sendAfter ? { sendAfter } : {}) } });
      }
    } catch (err) {
      console.error("[month-signup] DM failed:", err);
    }
  };

  if (decision.kind === "locked") {
    await tell(`locked:${month.id}:${args.userId}:${day}`, buildSignupLockedDm({ monthDate: month.firstKickoff, lang: month.language }));
    return { ok: true, changed: false, locked: true, outcome: decision.outcome, unknownDays: [] };
  }

  if (decision.outcome === "waiting") {
    await tell(
      `waiting-dm:${month.id}:${args.userId}`,
      buildSignupWaitingDm({ name: member.user.name, monthDate: month.firstKickoff, max: month.maxRegulars, lang: month.language }),
    );
    // The organisers are told ONCE a month that the regular places are full.
    try {
      if (await claimOnce(`${signupKeyPrefix(month.orgId)}waiting:${month.id}`, "admin-notice")) {
        await sendAdminNotice({
          orgId: month.orgId,
          now,
          nextPath: "/admin/months",
          text: (link) =>
            buildSignupWaitingAdminNotice({
              name: member.user.name,
              monthDate: month.firstKickoff,
              max: month.maxRegulars,
              link: link || appUrl("/admin/months"),
              lang: month.language,
            }),
        });
      }
    } catch (err) {
      console.error("[month-signup] waiting notice failed:", err);
    }
  }
  if (decision.unknownDays.length > 0) {
    await tell(
      `unknown-days:${month.id}:${args.userId}:${day}`,
      buildSignupUnknownDaysDm({ days: decision.unknownDays, kickoffs: month.kickoffs, lang: month.language }),
    );
  }

  // Sign-up has ended and the weekly flow runs this month: a change made
  // now (the page, an organiser, a late "IN FOR NOVEMBER") is put onto the
  // week's match too, through the ordinary attendance path.
  if (!month.open) {
    await placeOnWeek({ month, userId: args.userId, outcome: decision.outcome, paygMatchIds: decision.row.paygMatchIds, args, now }).catch((err) =>
      console.error(`[month-signup] placing ${args.userId} on the week of ${month.id} failed (the poll's sweep reconciles):`, err),
    );
  }
  return { ok: true, changed: true, locked: false, outcome: decision.outcome, unknownDays: decision.unknownDays };
}

/** After sign-up has ended: bring the week's match in line with a change
 *  to the month. Only matches the month has ALREADY put its regulars on;
 *  the seed does the rest. */
async function placeOnWeek(p: {
  month: SignupMonth;
  userId: string;
  outcome: SignupOutcome;
  paygMatchIds: string[];
  args: { source: SignupSource; actorUserId: string | null; byOrganiser?: boolean };
  now: Date;
}): Promise<void> {
  const { month, userId, now } = p;
  const live = month.matches.filter((m) => (LIVE as readonly string[]).includes(m.status) && m.date.getTime() > now.getTime());
  if (live.length === 0) return;
  const { loadMonthlyWeek } = await import("./monthly-week");
  const self = p.args.actorUserId === userId && !p.args.byOrganiser;
  const event = {
    cause: self ? ("self-attendance" as const) : ("admin-squad-edit" as const),
    actorKind: self ? ("player" as const) : ("admin" as const),
    actorUserId: p.args.actorUserId,
    sourceRef: month.id,
    note: `the month's list changed (${p.outcome}, by ${p.args.source})`,
  };
  for (const m of live) {
    const week = await loadMonthlyWeek(m.matchId);
    if (!week?.seeded) continue;
    const row = week.rows.find((r) => r.userId === userId);
    // A new regular goes on the fixture's next game; a PAYG player on the
    // games they named. A row they already have is their own word about
    // that week and is left alone.
    const wantsIn = p.outcome === "regular" ? m === live[0] : p.outcome === "payg" && p.paygMatchIds.includes(m.matchId);
    if (wantsIn) {
      if (!row) await registerAttendance(userId, m.matchId, { promoteFromBench: self, event });
    } else if ((p.outcome === "out" || p.outcome === "payg") && row && row.status !== "DROPPED") {
      // Off the month, or no longer a regular: off the week's squad too.
      await cancelAttendance(userId, m.matchId, event);
    }
  }
}

// ── Doors 1 and 2, from the group ──────────────────────────────────────

/** A club MatchTime acts for: on "monthly", approved, not dormant, not
 *  paused. The group doors ask this before they read or write anything. */
async function isLiveMonthlyClub(orgId: string): Promise<boolean> {
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { squadMode: true, approvalStatus: true, dormantAt: true, billingStatus: true },
  });
  return !!org && normaliseSquadMode(org.squadMode) === "monthly" && isClubOperational(org);
}

async function loadRoster(orgId: string): Promise<{ roster: SignupRosterMember[]; phoneOf: Map<string, string | null> }> {
  const [memberships, aliases] = await Promise.all([
    db.membership.findMany({
      where: { orgId, leftAt: null, user: { isActive: true } },
      select: { user: { select: { id: true, name: true, phoneNumber: true } } },
    }),
    db.userAlias.findMany({ where: { orgId }, select: { userId: true, alias: true } }),
  ]);
  return {
    roster: memberships.map((m) => ({
      userId: m.user.id,
      name: m.user.name,
      aliases: aliases.filter((a) => a.userId === m.user.id).map((a) => a.alias),
    })),
    phoneOf: new Map(memberships.map((m) => [m.user.id, m.user.phoneNumber])),
  };
}

const footerFacts = (m: SignupMonth) => ({
  kickoffs: m.kickoffs,
  carriedFrom: m.carriedFrom,
  endsAt: m.endsAt ?? m.firstKickoff,
  lang: m.language,
});

/** The month's list as MatchTime would post it now, and its hash. */
export function renderSignupList(month: SignupMonth): { text: string; hash: string } {
  const text = buildSignupListPost({
    list: buildSignupList({ members: month.members, maxRegulars: month.maxRegulars, matches: month.matches }),
    ...footerFacts(month),
  });
  return { text, hash: weekListHash(text) };
}

export interface SignupPasteResult {
  monthId: string;
  /** The month's list changed because of this paste. */
  changed: boolean;
  /** What was applied, for the AnalyzedMessage row. Never parsed. */
  applied: string[];
  notAdded: SignupNotAdded[];
  /** New "(paid)" marks on regulars' lines. Slice 4 records them. */
  paidClaims: SignupPaidClaim[];
  /** Whatever the member typed around the list. "" when it was only a list. */
  residual: string;
}

/**
 * Door 1: a list-shaped group message, for a club on "monthly" (the
 * caller checks). Returns null when it is not the list of a month
 * somebody can still join: the caller then does what it did before.
 *
 * `needHeader`: a week's list is live for this club right now, so a list
 * with no month in its title is that one, never the sign-up list.
 *
 * NEVER creates a player and never guesses one. Only the SENDER'S own
 * line is applied. Names written in for somebody else are left alone, and
 * the sender is told once a day.
 */
export async function handleSignupPaste(args: {
  orgId: string;
  body: string;
  waMessageId: string;
  sender: { userId: string | null; name: string | null };
  senderWhatsAppName?: string | null;
  needHeader: boolean;
  now?: Date;
}): Promise<SignupPasteResult | null> {
  const now = args.now ?? new Date();
  const list = parseMonthlyList(args.body);
  if (!list) return null;
  if (!(await isLiveMonthlyClub(args.orgId))) return null;
  const months = await loadJoinableMonths(args.orgId, now);
  if (months.length === 0) return null;
  const { roster, phoneOf } = await loadRoster(args.orgId);

  let month: SignupMonth | null = null;
  let outcome: ReturnType<typeof reconcileSignupPaste> | null = null;
  for (const m of months) {
    // With no month in the title, only a month still in sign-up.
    if (!list.month && !m.open) continue;
    const o = reconcileSignupPaste({
      list,
      members: m.members,
      roster,
      monthNumber: m.monthNumber,
      senderUserId: args.sender.userId,
      senderNames: [args.sender.name, args.senderWhatsAppName],
      needHeader: args.needHeader,
    });
    if (o.thisList) {
      month = m;
      outcome = o;
      break;
    }
  }
  if (!month || !outcome) return null;

  const applied: string[] = [];
  let changed = false;
  if (outcome.self && args.sender.userId) {
    const res = await applySignup({
      monthId: month.id,
      userId: args.sender.userId,
      choice: outcome.self.choice,
      days: outcome.self.days,
      source: "paste",
      actorUserId: args.sender.userId,
      now,
    });
    if (res.ok && res.changed) {
      changed = true;
      applied.push(`${res.outcome}:${args.sender.name ?? args.sender.userId}`);
    } else if (res.ok && res.locked) {
      applied.push("locked: says paid");
    }
  }

  // Names written in for somebody else: the sender is told, once a day.
  if (outcome.notAdded.length > 0 && args.sender.userId) {
    const phone = phoneOf.get(args.sender.userId)?.replace(/^\+/, "");
    try {
      const day = formatLondon(now, "yyyy-MM-dd");
      if (phone && (await claimOnce(`${signupKeyPrefix(args.orgId)}paste-others:${month.id}:${args.sender.userId}:${day}`, "signup-dm"))) {
        const sendAfter = adminNoticeSendAfter(now);
        await db.botJob.create({
          data: {
            orgId: args.orgId,
            kind: "dm",
            phone,
            text: buildSignupPasteOthersDm({
              names: [...new Set(outcome.notAdded.map((n) => n.name))],
              monthDate: month.firstKickoff,
              lang: month.language,
            }),
            ...(sendAfter ? { sendAfter } : {}),
          },
        });
      }
    } catch (err) {
      console.error("[month-signup] paste note failed:", err);
    }
  }

  // The group has just seen this list: when it is the list as MatchTime
  // now has it, record that, so the scheduler does not post it back.
  try {
    const after = await loadSignupMonth(month.id);
    if (after?.open) {
      const ours = buildSignupList({ members: after.members, maxRegulars: after.maxRegulars, matches: after.matches });
      if (signupPasteShowsSameList({ list, ours, roster })) await recordSignupListShown(after, renderSignupList(after).hash, "signup-list-seen");
    }
  } catch (err) {
    console.error("[month-signup] could not record the list as seen (it will be posted):", err);
  }

  return {
    monthId: month.id,
    changed,
    applied,
    notAdded: outcome.notAdded,
    paidClaims: outcome.paidClaims,
    residual: signupPasteResidual(args.body, footerFacts(month)),
  };
}

export interface SignupMessageResult {
  monthId: string;
  choice: SignupChoice;
  changed: boolean;
  locked: boolean;
  outcome: SignupOutcome;
}

/**
 * Door 2: a typed sign-up, for a club on "monthly" (the caller checks).
 * "IN FOR NOVEMBER" names its month; a bare "IN" counts only as a reply
 * to the month's list (`quotedBody`, which a Pi that forwards quoted
 * messages sends). Null for anything else, and for a sender we cannot
 * match to a player: the message then goes on exactly as before.
 */
export async function handleSignupMessage(args: {
  orgId: string;
  body: string;
  /** The message this one replies to, when the Pi forwarded it. */
  quotedBody?: string | null;
  sender: { userId: string | null };
  now?: Date;
}): Promise<SignupMessageResult | null> {
  const now = args.now ?? new Date();
  if (!args.sender.userId) return null;
  const quotedList = args.quotedBody ? parseMonthlyList(args.quotedBody) : null;
  const quotedMonth = quotedList?.month?.month ?? null;
  const ask = readSignupMessage(args.body, { quoted: quotedMonth !== null });
  if (!ask) return null;
  const wanted = ask.month ?? quotedMonth;
  if (wanted === null) return null;
  if (!(await isLiveMonthlyClub(args.orgId))) return null;
  const month = (await loadJoinableMonths(args.orgId, now)).find((m) => m.monthNumber === wanted);
  if (!month) return null;
  const res = await applySignup({
    monthId: month.id,
    userId: args.sender.userId,
    choice: ask.choice,
    days: ask.days,
    source: "reply",
    actorUserId: args.sender.userId,
    now,
  });
  if (!res.ok) return null;
  return { monthId: month.id, choice: ask.choice, changed: res.changed, locked: res.locked, outcome: res.outcome };
}

// ── The list post ──────────────────────────────────────────────────────

/**
 * Record that the group has just seen the sign-up list with this hash:
 *   "group-message"     MatchTime posted it (the scheduler's own claim
 *                       writes that row; this is for a post made outside it);
 *   "signup-list-seen"  a member's paste showed it (does not count towards
 *                       the 30 minutes).
 */
export async function recordSignupListShown(
  month: Pick<SignupMonth, "id" | "orgId">,
  hash: string,
  kind: "group-message" | "signup-list-seen",
): Promise<void> {
  const prefix = signupListKeyPrefix(month.orgId, month.id);
  const shown = await db.sentNotification.count({ where: { key: { startsWith: prefix } } });
  await db.sentNotification.create({ data: { key: `${prefix}${hash}:${shown}`, kind } });
}

/**
 * The sign-up list posts due for a club right now, for `computeDuePosts`:
 * ONE message per month in sign-up, when the list differs from the one the
 * group last saw, at most every 30 minutes, 08:00 to 21:59 London. The key
 * carries a running number, so a list that returns to an earlier state is
 * posted again. The caller has checked the club is monthly.
 */
export async function signupListPosts(
  orgId: string,
  now: Date,
): Promise<{
  posts: Array<{ key: string; text: string }>;
  /** Every month of the club in sign-up, for the scheduler: a match of one
   *  is not announced the weekly way while its list is open. */
  months: Array<{ id: string; monthStart: string; fixture: RecurringFixtureKey }>;
}> {
  const open = await db.squadMonth.findMany({ where: { orgId, status: "open", listOpenedAt: { not: null } }, select: MONTH_SELECT });
  const out: Array<{ key: string; text: string }> = [];
  const months = open.map((row) => ({
    id: row.id,
    monthStart: row.monthStart.toISOString().slice(0, 10),
    fixture: { orgId, venue: row.activity.venue, dayOfWeek: row.activity.dayOfWeek },
  }));
  for (const row of open) {
    const month = await toSignupMonth(row);
    if (!month?.endsAt) continue;
    const { text, hash } = renderSignupList(month);
    const prefix = signupListKeyPrefix(orgId, month.id);
    const shown = await db.sentNotification.findMany({
      where: { key: { startsWith: prefix } },
      select: { key: true, kind: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    const due = decideSignupListPost({
      now,
      open: month.open,
      endsAt: month.endsAt,
      hash,
      lastShownHash: shown[0] ? shown[0].key.slice(prefix.length).split(":")[0] : null,
      lastPostAt: shown.find((r) => r.kind === "group-message")?.createdAt ?? null,
    });
    if (due) out.push({ key: `${prefix}${hash}:${shown.length}`, text });
  }
  return { posts: out, months };
}
