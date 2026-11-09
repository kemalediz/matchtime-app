/**
 * Monthly squad, slice 5: the weekly flow's PURE rules (2026-10-06).
 * Plan: MDs/monthly-squad-plan-2026-10-05.md, sections 5 and 6.2.
 *
 * A club on `squadMode = "monthly"` with a RUNNING month plays each week
 * from the month's list: the regulars are in unless they say OUT, a
 * regular who is out is "Paid but can't play" (and, by the club's rule,
 * earns a game of credit), and the place goes to the waiting list and then
 * to the pay-as-you-go (PAYG) pool, whose player takes that slot number.
 *
 * Everything here is a decision on facts already loaded: no database, no
 * clock of its own, no model. `monthly-week.ts` loads the rows and writes
 * the result. A club on "weekly" (every club before this, Sutton FC
 * included) never reaches any of it.
 */
import { formatLondon, londonDateTimeToUtc } from "./london-time";
import { inMessageHours, messageHoursDayStart, type QuietHours } from "./message-hours";
import { type MonthlyList, type MonthlyListEntry } from "./monthly-list";
import { nameKey, type MonthCreditRule } from "./squad-month-rules";
import { entryResolver, type Resolved } from "./month-signup-rules";
import { isNamedMember, MAX_NEW_PLAYERS_PER_PASTE, newcomerLineOf, type NewcomerLine } from "./month-newcomer-rules";

export type WeekPaid = "none" | "claimed" | "confirmed";
export type WeekStatus = "CONFIRMED" | "BENCH" | "DROPPED";

/** One member of the month, as this week's match sees them. */
export interface WeekMember {
  userId: string;
  name: string;
  kind: "regular" | "payg";
  /** The list number, stable for the month. */
  slot: number | null;
  /** "claimed" is "says paid" (D3). Shown as paid on the list, never confirmed by it. */
  paid: WeekPaid;
  /** A regular who said ahead of time they miss THIS match. */
  absent: boolean;
  /** A PAYG player who named THIS match's date ("PAYG 12th only"). */
  paygDated: boolean;
  /** They have left the group (or been deactivated). Still a member of the
   *  month for what they are OWED: every credit they earned stands. But
   *  they are no longer seeded, listed or holding a slot number. */
  left?: boolean;
  /** "4 only" (2026-10-29): this regular has already played the games
   *  they committed to. This week is an away week for them, and a game
   *  they play anyway is pay-as-you-go (`commitmentForMatch`). */
  extra?: boolean;
  /** "4 only": missing this week earns no credit. They never paid for it. */
  freeMiss?: boolean;
}

/**
 * Where a "4 only" regular stands on one match of the month (2026-10-29).
 * They pay for `committed` of the `covered` games, so `covered - committed`
 * weeks are theirs to miss for nothing.
 *
 *  - `extra`: they have already played the games they committed to. This
 *    week is an away week (seeded out, no credit), and if they play it
 *    anyway it is a PAYG game, paid on the night;
 *  - `freeMiss`: missing this week earns NO credit. A miss (dropped, away,
 *    or the week called off) uses up the free weeks first; only a miss
 *    beyond them earns a credit, because only then did they pay for a game
 *    they did not get.
 *
 * `earlier`: the month's earlier games since they joined, in order, true
 * where they played (CONFIRMED). `playedBefore`: games of the month played
 * before MatchTime knew of it, which count as played (plan 4.5). With no
 * commitment, neither flag is ever set: today's behaviour.
 */
export function commitmentForMatch(p: {
  gamesCovered: number;
  gamesCommitted: number | null | undefined;
  playedBefore: number;
  earlier: boolean[];
}): { extra: boolean; freeMiss: boolean } {
  if (p.gamesCommitted == null) return { extra: false, freeMiss: false };
  const covered = Math.max(0, p.gamesCovered);
  const committed = Math.max(0, Math.min(p.gamesCommitted, covered));
  const played = Math.max(0, p.playedBefore) + p.earlier.filter(Boolean).length;
  const missed = p.earlier.filter((x) => !x).length;
  const extra = played >= committed;
  return { extra, freeMiss: extra || missed < covered - committed };
}

/** One Attendance row on this week's match. */
export interface WeekRow {
  userId: string;
  name: string;
  status: WeekStatus;
  position: number;
  /** When they went out (their last move to DROPPED). Only loaded where
   *  it decides something: the `filled-only` credit rule. */
  outAt?: Date | null;
  /** On the waiting list because they ASKED to be ("put me on the bench"),
   *  not because the squad was full. Read from the attendance log where it
   *  decides something: the seed's priority and the credit. */
  choseBench?: boolean;
}

// ── Seeding (plan 5.1) ─────────────────────────────────────────────────

export interface MonthlySeedWrite {
  userId: string;
  status: WeekStatus;
  /** A regular's own slot number; a dated PAYG player's lowest free one. */
  position: number;
  /** A regular's row carries `paymentMethod = "monthly"`: every per-match
   *  payment path skips it (plan 5.6). */
  monthly: boolean;
  /** Written on the AttendanceEvent. Never parsed. */
  note: string;
}

export const SEED_NOTE_REGULAR = "regular of the month";
export const SEED_NOTE_AWAY = "away this week";
/** "4 only": they have played the games they committed to this month. */
export const SEED_NOTE_COMMITTED = "played the games they committed to: away this week";
export const SEED_NOTE_NO_PLACE = "regular of the month: no place left";
export const SEED_NOTE_PAYG = "PAYG for this date";

export const SEED_NOTE_PRIORITY = "the month's regulars have priority: moved to the waiting list";
export const SEED_NOTE_PROMOTED = "regular of the month: brought in from the waiting list";

/**
 * Who is written onto this week's match from the month.
 *
 *  - every regular, in slot order, at `position = slot`: CONFIRMED while
 *    there is room, the waiting list after that;
 *  - REGULARS HAVE PRIORITY over anyone who is not a regular. A regular
 *    has paid for the place, so a non-regular who said IN before the seed
 *    (`bump`, last in first) goes to the waiting list when the regulars
 *    need the place, and a regular who was put on the waiting list before
 *    the seed (`promote`) is brought in;
 *  - a regular who said they are away this week is written OUT, so the
 *    list shows them under "Paid but can't play" from the start;
 *  - a PAYG player only on a date they named, in whatever room is left;
 *  - a regular's own OUT, and a regular already in, are NOT touched. Any
 *    regular's existing row is marked as paid for by the month
 *    (`markMonthly`).
 */
export function decideMonthlySeed(args: {
  members: WeekMember[];
  targetRows: Array<{ userId: string; status: string; position?: number; choseBench?: boolean }>;
  maxPlayers: number;
  /** The club's organisers (OWNER, ADMIN). One who is not on the month's
   *  list and is already IN is never moved to the waiting list. */
  protectedUserIds?: Iterable<string>;
}): { write: MonthlySeedWrite[]; markMonthly: string[]; promote: string[]; bump: string[] } {
  const rowOf = new Map(args.targetRows.map((r) => [r.userId, r]));
  const bySlot = (a: WeekMember, b: WeekMember): number =>
    (a.slot ?? Number.MAX_SAFE_INTEGER) - (b.slot ?? Number.MAX_SAFE_INTEGER) || a.userId.localeCompare(b.userId);
  // A regular who has left the group is not seeded (their credits stand).
  const regulars = args.members.filter((m) => m.kind === "regular" && !m.left).sort(bySlot);
  const regularIds = new Set(regulars.map((m) => m.userId));
  const dated = args.members.filter((m) => m.kind === "payg" && m.paygDated && !m.left).sort(bySlot);
  const protectedIds = new Set(args.protectedUserIds ?? []);

  const taken = new Set<number>(regulars.map((m) => m.slot).filter((s): s is number => s != null));
  let next = 1;
  const freeNumber = (): number => {
    while (taken.has(next)) next++;
    taken.add(next);
    return next;
  };

  const regularsIn = regulars.filter((m) => rowOf.get(m.userId)?.status === "CONFIRMED").length;
  /** Non-regulars holding a place, the LAST in first: they are the ones moved. */
  const others = args.targetRows
    .filter((r) => r.status === "CONFIRMED" && !regularIds.has(r.userId))
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0) || b.userId.localeCompare(a.userId));
  /** Regulars who want a place: no row yet (and not away), or waiting
   *  because the squad was full. One who ASKED for the bench keeps it. */
  const wanting = regulars.filter((m) => {
    const row = rowOf.get(m.userId);
    return row ? row.status === "BENCH" && !row.choseBench : !m.absent;
  });
  const bumpable = others.filter((r) => !protectedIds.has(r.userId));
  const kept = others.length - bumpable.length;
  const placeable = Math.min(wanting.length, Math.max(0, args.maxPlayers - regularsIn - kept));
  const free = Math.max(0, args.maxPlayers - regularsIn - others.length);
  const bump = bumpable.slice(0, Math.max(0, placeable - free)).map((r) => r.userId);
  let room = Math.max(0, args.maxPlayers - regularsIn - placeable - (others.length - bump.length));

  const write: MonthlySeedWrite[] = [];
  const markMonthly: string[] = [];
  const promote: string[] = [];
  const placed = new Set(wanting.slice(0, placeable).map((m) => m.userId));
  for (const m of regulars) {
    const row = rowOf.get(m.userId);
    if (row) {
      // A game beyond a "4 only" commitment is not the month's: PAYG.
      if (!m.extra) markMonthly.push(m.userId);
      if (row.status === "BENCH" && placed.has(m.userId)) promote.push(m.userId);
      continue;
    }
    const position = m.slot ?? freeNumber();
    if (m.absent) {
      write.push({ userId: m.userId, status: "DROPPED", position, monthly: !m.extra, note: m.extra ? SEED_NOTE_COMMITTED : SEED_NOTE_AWAY });
    } else if (placed.has(m.userId)) {
      write.push({ userId: m.userId, status: "CONFIRMED", position, monthly: true, note: SEED_NOTE_REGULAR });
    } else {
      write.push({ userId: m.userId, status: "BENCH", position, monthly: true, note: SEED_NOTE_NO_PLACE });
    }
  }
  for (const m of dated) {
    if (rowOf.has(m.userId)) continue;
    const position = m.slot != null && !taken.has(m.slot) ? (taken.add(m.slot), m.slot) : freeNumber();
    const status: WeekStatus = room > 0 ? "CONFIRMED" : "BENCH";
    if (room > 0) room--;
    write.push({ userId: m.userId, status, position, monthly: false, note: SEED_NOTE_PAYG });
  }
  return { write, markMonthly, promote, bump };
}

// ── The week's list (plan 5.4) ─────────────────────────────────────────

export interface WeekSlot {
  slot: number;
  /** null: nobody is in this slot this week. */
  userId: string | null;
  name: string;
  /** "paid": a regular who has paid or says so. "payg": pays per game. */
  mark: "paid" | "payg" | null;
}

export interface WeekName {
  userId: string;
  name: string;
}

export interface WeekList {
  /** 1 to the club's places (more only if somebody holds a higher number). */
  slots: WeekSlot[];
  /** Regulars who are out this week and have paid, or say so. */
  paidCantPlay: WeekName[];
  /** Regulars who are out this week and have not paid. Never shown as paid. */
  cantPlay: WeekName[];
  /** The waiting list. */
  reserves: WeekName[];
  /** Places still free. */
  open: number;
}

export type PlacedWeekSlot = WeekSlot & { userId: string };

/**
 * Who has a place this week, in the order the week's post prints them:
 * the squad (everybody without a PAYG mark), then pay as you go, each in
 * slot order. The post numbers them 1, 2, 3 with no gaps (Kemal,
 * 2026-11-07), so a printed number is a position on this list, never a
 * slot number. A pasted copy is read back against this same order
 * (`reconcileMonthPaste`, `pasteShowsSameList`).
 */
export function weekListPlaces(list: WeekList): { squad: PlacedWeekSlot[]; payg: PlacedWeekSlot[] } {
  const placed = list.slots.filter((s): s is PlacedWeekSlot => s.userId !== null);
  return { squad: placed.filter((s) => s.mark !== "payg"), payg: placed.filter((s) => s.mark === "payg") };
}

/** Slot number to who sits in it, for the CONFIRMED rows given. */
function placeRows(
  members: WeekMember[],
  rows: WeekRow[],
  maxPlayers: number,
  /** Leave this player's row out of the seating (they still count as having answered). */
  skipUserId: string | null = null,
): { placed: Map<number, WeekSlot>; kept: Set<number> } {
  const memberOf = new Map(members.map((m) => [m.userId, m]));
  const rowOf = new Map(rows.map((r) => [r.userId, r]));
  const placed = new Map<number, WeekSlot>();
  const markOf = (userId: string): WeekSlot["mark"] => {
    const m = memberOf.get(userId);
    // A "4 only" regular playing a game beyond their commitment pays for it.
    if (m?.kind !== "regular" || m.extra) return "payg";
    return m.paid === "none" ? null : "paid";
  };

  // A regular who has not answered yet (no row, not away) keeps their slot.
  const kept = new Set<number>();
  for (const m of members) {
    if (m.kind === "regular" && !m.left && m.slot != null && !m.absent && !rowOf.has(m.userId)) kept.add(m.slot);
  }

  const confirmed = rows.filter((r) => r.status === "CONFIRMED" && r.userId !== skipUserId);
  const rest: WeekRow[] = [];
  for (const r of confirmed) {
    const m = memberOf.get(r.userId);
    if (m?.kind === "regular" && m.slot != null && !placed.has(m.slot)) {
      placed.set(m.slot, { slot: m.slot, userId: r.userId, name: r.name, mark: markOf(r.userId) });
    } else {
      rest.push(r);
    }
  }
  rest.sort((a, b) => a.position - b.position || a.userId.localeCompare(b.userId));
  for (const r of rest) {
    let slot = r.position;
    const free = (s: number): boolean => s >= 1 && !placed.has(s) && !kept.has(s);
    if (!(free(slot) && slot <= maxPlayers)) {
      slot = 1;
      while (!free(slot)) slot++;
    }
    placed.set(slot, { slot, userId: r.userId, name: r.name, mark: markOf(r.userId) });
  }
  return { placed, kept };
}

/**
 * The list as the group writes it: numbered slots with the names that are
 * in this week, then who has paid but can't play.
 *
 *  - a regular sits in their own number;
 *  - anyone else who is in (a PAYG player, a fill-in) sits in the number
 *    they took (`Attendance.position`), or the lowest free one;
 *  - a paid mark is shown as soon as it is CLAIMED (D3). Whether it is
 *    confirmed is the collector's business and is not on the list.
 */
export function buildWeekList(args: { members: WeekMember[]; rows: WeekRow[]; maxPlayers: number }): WeekList {
  const { members, rows, maxPlayers } = args;
  const { placed } = placeRows(members, rows, maxPlayers);
  const size = Math.max(maxPlayers, ...placed.keys());
  const slots: WeekSlot[] = [];
  for (let s = 1; s <= size; s++) slots.push(placed.get(s) ?? { slot: s, userId: null, name: "", mark: null });

  const rowOf = new Map(rows.map((r) => [r.userId, r]));
  const paidCantPlay: WeekName[] = [];
  const cantPlay: WeekName[] = [];
  const regulars = members
    .filter((m) => m.kind === "regular" && !m.left)
    .sort((a, b) => (a.slot ?? Number.MAX_SAFE_INTEGER) - (b.slot ?? Number.MAX_SAFE_INTEGER) || a.userId.localeCompare(b.userId));
  for (const m of regulars) {
    if (!isOut(m, rowOf.get(m.userId))) continue;
    (m.paid === "none" ? cantPlay : paidCantPlay).push({ userId: m.userId, name: m.name });
  }

  const reserves = rows
    .filter((r) => r.status === "BENCH")
    .sort((a, b) => a.position - b.position || a.userId.localeCompare(b.userId))
    .map((r) => ({ userId: r.userId, name: r.name }));

  const confirmedCount = rows.filter((r) => r.status === "CONFIRMED").length;
  return { slots, paidCantPlay, cantPlay, reserves, open: Math.max(0, maxPlayers - confirmedCount) };
}

/** A regular is out this week: they dropped, or said beforehand they are away. */
function isOut(m: WeekMember, row: WeekRow | undefined): boolean {
  if (row) return row.status === "DROPPED";
  return m.absent;
}

/**
 * The slot number somebody who has just become CONFIRMED takes (plan 5.3:
 * "the winner takes the vacated slot number"). A regular takes their own
 * number while it is free. Anyone else takes the LOWEST free number, so a
 * fill-in is written into the slot a regular vacated, as the group does by
 * hand. `vacatedByUserId` is that regular, when there is one.
 * Null when the player is not playing.
 */
export function decideSlotFor(args: {
  members: WeekMember[];
  rows: WeekRow[];
  maxPlayers: number;
  userId: string;
}): { slot: number; vacatedByUserId: string | null } | null {
  const mine = args.rows.find((r) => r.userId === args.userId);
  if (!mine || mine.status !== "CONFIRMED") return null;
  const { placed, kept } = placeRows(args.members, args.rows, args.maxPlayers, args.userId);
  const me = args.members.find((m) => m.userId === args.userId);
  if (me?.kind === "regular" && me.slot != null && !placed.has(me.slot)) {
    return { slot: me.slot, vacatedByUserId: null };
  }
  let slot = 1;
  while (placed.has(slot) || kept.has(slot)) slot++;
  const rowOf = new Map(args.rows.map((r) => [r.userId, r]));
  const holder = args.members.find((m) => m.kind === "regular" && m.slot === slot && m.userId !== args.userId);
  const vacated = holder && isOut(holder, rowOf.get(holder.userId)) ? holder.userId : null;
  return { slot, vacatedByUserId: vacated };
}

// ── Credits (plan 5.2, decision D2) ────────────────────────────────────

export interface MissedCreditRow {
  id: string;
  userId: string;
  voidedAt: Date | null;
  voidedById: string | null;
  appliedMonthId: string | null;
  createdById: string | null;
}

/**
 * Which "missed" credits this match should have, against the ones it has.
 * State-based, so it can be run after every change and on every poll.
 *
 * A regular MISSES the game when they are not CONFIRMED on it: they
 * dropped, they said beforehand they are away, or they are on the waiting
 * list (a regular who paid and was left without a place, for example one
 * who dropped, came back and found the place taken).
 *
 *   any-miss      every game a paid (or says-paid) regular misses, a late
 *                 drop included;
 *   filled-only   only when their place was filled. A regular on the
 *                 waiting list always counts (the squad is full without
 *                 them). For regulars who are out, each player who is in
 *                 and is not a regular fills ONE vacated place, and the
 *                 places are filled in the order they were vacated: the
 *                 earliest drop first (`outAt`; an away week declared
 *                 beforehand counts as earliest), then the lower slot
 *                 number, then the user id. So with two regulars out and
 *                 one fill-in, the one who dropped first is credited;
 *   none          never.
 *
 * `create`: regulars who should have a credit and have none. A credit an
 * admin voided is never written again.
 * `voidIds`: credits MatchTime wrote itself that no longer hold (the
 * regular is playing after all), unless they have already been used
 * against a month. NEVER the credit of somebody who has left the group or
 * is no longer a member of the month: an earned credit stays owed.
 */
export function decideMissedCredits(args: {
  rule: MonthCreditRule;
  members: WeekMember[];
  rows: WeekRow[];
  maxPlayers: number;
  existing: MissedCreditRow[];
  /** Slice 6: players who already hold a LIVE credit for this game for
   *  another reason (it was called off, or they left part-way). One game
   *  is one credit: no "missed" credit is written beside it. */
  creditedElsewhere?: ReadonlySet<string>;
}): { create: string[]; voidIds: string[]; releaseElsewhere: Array<{ creditId: string; userId: string; monthId: string }> } {
  const rowOf = new Map(args.rows.map((r) => [r.userId, r]));
  const regulars = args.members.filter((m) => m.kind === "regular");
  const misses = (m: WeekMember): boolean => {
    const row = rowOf.get(m.userId);
    // After they left the group only a row says they were ever in this game.
    if (!row) return m.absent && !m.left;
    // On the waiting list by their own choice: not a game they were kept out of.
    if (row.status === "BENCH" && row.choseBench) return false;
    return row.status !== "CONFIRMED";
  };

  // filled-only: whose vacated place counts as filled.
  const filled = new Set<string>();
  if (args.rule === "filled-only") {
    const regularIds = new Set(regulars.map((m) => m.userId));
    const fillIns = args.rows.filter((r) => r.status === "CONFIRMED" && !regularIds.has(r.userId)).length;
    const time = (m: WeekMember): number => rowOf.get(m.userId)?.outAt?.getTime() ?? 0;
    const out = regulars
      .filter((m) => isOut(m, rowOf.get(m.userId)))
      .sort(
        (a, b) =>
          time(a) - time(b) ||
          (a.slot ?? Number.MAX_SAFE_INTEGER) - (b.slot ?? Number.MAX_SAFE_INTEGER) ||
          a.userId.localeCompare(b.userId),
      );
    for (const m of out.slice(0, fillIns)) filled.add(m.userId);
    for (const m of regulars) if (rowOf.get(m.userId)?.status === "BENCH") filled.add(m.userId);
  }

  const entitled = new Set<string>();
  for (const m of regulars) {
    if (m.paid === "none" || !misses(m) || args.rule === "none") continue;
    // "4 only": a week they never paid for earns nothing.
    if (m.freeMiss) continue;
    if (args.rule === "filled-only" && !filled.has(m.userId)) continue;
    entitled.add(m.userId);
  }

  const create: string[] = [];
  for (const userId of entitled) {
    const mine = args.existing.filter((e) => e.userId === userId);
    if (mine.some((e) => e.voidedAt === null)) continue;
    if (mine.some((e) => e.voidedById !== null)) continue;
    if (args.creditedElsewhere?.has(userId)) continue;
    create.push(userId);
  }
  // A credit is taken back ONLY from a regular who is still in the group
  // and no longer misses the game. Leaving the group, or no longer being a
  // member of the month, never voids a credit that was earned: it stays
  // owed, for the collector to settle (plan section 7, "Leaving mid-month").
  const here = new Set(regulars.filter((m) => !m.left).map((m) => m.userId));
  const voidIds = args.existing
    .filter(
      (e) =>
        e.voidedAt === null &&
        here.has(e.userId) &&
        !entitled.has(e.userId) &&
        e.appliedMonthId === null &&
        e.createdById === null,
    )
    .map((e) => e.id);
  // "4 only" (PR #464 review, round 2): a week they never paid for whose
  // credit was already USED against a month is handed back there (that
  // month asks one game more), as a called-off week's is. Otherwise they
  // would get the share twice. A regular who simply played after all keeps
  // a used credit, as before.
  // Only when they MISSED that week (review round 3): a free week they
  // played after all is a week like any other, whatever the credit rule.
  const free = new Set(regulars.filter((m) => m.freeMiss && !m.left && misses(m)).map((m) => m.userId));
  const releaseElsewhere = args.existing
    .filter((e) => e.voidedAt === null && free.has(e.userId) && e.appliedMonthId !== null && e.createdById === null)
    .map((e) => ({ creditId: e.id, userId: e.userId, monthId: e.appliedMonthId as string }));
  return { create, voidIds, releaseElsewhere };
}

/**
 * The offers still to open for a match's free places (review item 5): one
 * per open place, never more than are open, counting the offers already
 * open. A place a regular vacated is offered in their name first (so the
 * offer is closed when somebody takes that slot); a place nobody ever
 * held is offered with no name. Returns the `replacingUserId` of each
 * offer to create.
 */
export function planOpenPlaceOffers(args: {
  members: WeekMember[];
  rows: WeekRow[];
  maxPlayers: number;
  /** `replacingUserId` of every offer already open. */
  openOffers: Array<string | null>;
}): Array<string | null> {
  const list = buildWeekList(args);
  const need = list.open - args.openOffers.length;
  if (need <= 0) return [];
  const named = new Set(args.openOffers.filter((u): u is string => u !== null));
  const rowOf = new Map(args.rows.map((r) => [r.userId, r]));
  const vacated = args.members
    .filter((m) => m.kind === "regular" && m.slot != null && isOut(m, rowOf.get(m.userId)) && !named.has(m.userId))
    .filter((m) => !list.slots.find((s) => s.slot === m.slot)?.userId)
    .sort((a, b) => a.slot! - b.slot!)
    .map((m) => m.userId);
  const out: Array<string | null> = [];
  for (let i = 0; i < need; i++) out.push(vacated[i] ?? null);
  return out;
}

// ── The PAYG pool (plan 5.3) ───────────────────────────────────────────

export interface PoolCandidate {
  userId: string;
  name: string | null;
  phoneNumber: string | null;
  /** `Membership.subMatchInviteDm`: false means "do not invite me". */
  inviteDm: boolean;
  leftAt: Date | null;
  isActive: boolean;
}

/**
 * Who is asked when a place opens and nobody is waiting: this month's
 * PAYG players and anyone who played per game lately (the caller loads
 * both), minus anyone who opted out of invites, has left, is already on
 * the match in any state, is a regular of the month, or has no number.
 */
export function selectPaygPool(args: {
  candidates: PoolCandidate[];
  onMatchUserIds: Iterable<string>;
  regularUserIds: Iterable<string>;
}): PoolCandidate[] {
  const onMatch = new Set(args.onMatchUserIds);
  const regulars = new Set(args.regularUserIds);
  const seen = new Set<string>();
  const out: PoolCandidate[] = [];
  for (const c of args.candidates) {
    if (seen.has(c.userId)) continue;
    seen.add(c.userId);
    if (!c.inviteDm || c.leftAt || !c.isActive || !c.phoneNumber) continue;
    if (onMatch.has(c.userId) || regulars.has(c.userId)) continue;
    out.push(c);
  }
  return out;
}

/**
 * Bench first, then the pool (plan 5.3). With anyone on the waiting list
 * today's bench offer runs unchanged, and an organiser-pick club's admins
 * pick: in neither case is the pool asked.
 */
export function paygPoolOfferAllowed(p: { pickMode: string | null | undefined; benchCount: number; poolSize: number }): boolean {
  return p.pickMode !== "organiser" && p.benchCount === 0 && p.poolSize > 0;
}

// ── When the list is posted (plan 5.4) ─────────────────────────────────

/** "At most once every 30 minutes." */
export const LIST_REPOST_FLOOR_MS = 30 * 60 * 1000;
/** The match morning post: from the club's day start (09:00 by default)
 *  until noon. */
const MORNING_UNTIL_HOUR = 12;

/**
 * ONE MORNING MESSAGE ON MATCH DAY (Kemal, 2026-11-09). The Vets got
 * "Still 3 short for tonight's ... Any takers?" at 08:00 (the match-day
 * morning chase) and the same unchanged list at 09:00 (the list's morning
 * post): "no need to repeat yourself, you already said 3 needed at 8am."
 *
 * Has the players' group already had this match's morning message today?
 * Yes when, on match day, either
 *   - the match-day morning chase went to the players' group today
 *     (`morningChaseSent`), or
 *   - the group was shown this match's list since the club's day start
 *     (`messageHoursDayStart`, 09:00 by default): the list's morning post,
 *     a changed list, or a reply that showed it.
 * The list's morning post and the chase both read this one definition, so
 * whichever goes first, the other stays quiet. A CHANGED list is not held
 * by it (`decideListPost` posts a change before it asks). Every club: a
 * weekly club's match-day final list reads it too (`listPublishHeld`,
 * weekly-deadlines.ts), with "unchanged" as the squad the group last saw.
 */
export function matchMorningMessageSent(p: {
  now: Date;
  matchDate: Date;
  morningChaseSent?: boolean;
  /** When the group was last shown this match's list (null: never). */
  lastListShownAt?: Date | null;
  quiet?: QuietHours | null;
}): boolean {
  const matchDay = formatLondon(p.matchDate, "yyyy-MM-dd");
  if (formatLondon(p.now, "yyyy-MM-dd") !== matchDay) return false;
  if (p.morningChaseSent) return true;
  const morningStart = londonDateTimeToUtc(matchDay, messageHoursDayStart(p.quiet ?? undefined));
  return !!p.lastListShownAt && p.lastListShownAt.getTime() >= morningStart.getTime();
}

/**
 * Is a list post due?
 *
 *   "change"   the list differs from the one the group last saw (a post of
 *              ours, or a member's paste that matched our state);
 *   "morning"  match morning, from the club's day start (09:00 by default)
 *              to 11:59 London, at most once, for the unchanged list, and
 *              only while the group has had no morning message about the
 *              game today (`matchMorningMessageSent`): not after a list
 *              post that morning, and not after the match-day morning
 *              chase (2026-11-09). Also held while the group saw this same
 *              list a moment ago (`sameListShownRecently`): somebody asked
 *              "who's in?" at 08:30 and got it, so 09:00 would repeat it.
 *              That one is held, not dropped: a later poll that morning
 *              posts it once the three hours are up;
 *   null       nothing to post.
 *
 * Never in the club's quiet hours (by default 23:00 to 08:59 London), never within 30 minutes of the
 * last list post, never once the teams are out (the team sheet is the
 * announcement then), and only for the fixture's next match.
 */
export function decideListPost(p: {
  now: Date;
  matchDate: Date;
  /** The hash of the list as it stands. */
  hash: string;
  /** The hash the group last saw; null when it has seen none. */
  lastShownHash: string | null;
  /** When MatchTime last POSTED a list for this match. */
  lastPostAt: Date | null;
  live: boolean;
  nextUpcoming: boolean;
  teamsOut: boolean;
  /** The group saw the list with `lastShownHash` inside the quiet window
   *  the weekly roster uses (`shownInQuietWindow`, roster-shown.ts: three
   *  hours): a post or a reply of ours, or a member's paste of it. Only
   *  the morning post reads it; a CHANGED list is posted regardless. */
  sameListShownRecently?: boolean;
  /** The match-day morning chase went to the players' group today. Only
   *  the morning post reads it (`matchMorningMessageSent`). */
  morningChaseSent?: boolean;
  /** The club's quiet hours (absent: the default). The morning post waits
   *  for the club's day start (`messageHoursDayStart`). */
  quiet?: QuietHours | null;
}): "change" | "morning" | null {
  if (!p.live || !p.nextUpcoming || p.teamsOut) return null;
  if (p.now.getTime() >= p.matchDate.getTime()) return null;
  if (!inMessageHours(p.now, p.quiet ?? undefined)) return null;
  if (p.lastPostAt && p.now.getTime() - p.lastPostAt.getTime() < LIST_REPOST_FLOOR_MS) return null;
  if (p.hash !== p.lastShownHash) return "change";

  const matchDay = formatLondon(p.matchDate, "yyyy-MM-dd");
  if (formatLondon(p.now, "yyyy-MM-dd") !== matchDay || Number(formatLondon(p.now, "H")) >= MORNING_UNTIL_HOUR) return null;
  const morningStart = londonDateTimeToUtc(matchDay, messageHoursDayStart(p.quiet ?? undefined));
  // Not before the club's day starts: with quiet hours off, 03:00 is not the morning.
  if (p.now.getTime() < morningStart.getTime()) return null;
  if (
    matchMorningMessageSent({
      now: p.now,
      matchDate: p.matchDate,
      morningChaseSent: p.morningChaseSent,
      lastListShownAt: p.lastPostAt,
      quiet: p.quiet,
    })
  ) {
    return null;
  }
  if (p.sameListShownRecently) return null;
  return "morning";
}

/** A short stable hash of the rendered list (cyrb53), for the post's key. */
export function weekListHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

// ── A member's pasted list, against the week (plan 6.2) ────────────────

export interface PasteRosterMember {
  userId: string;
  name: string | null;
  aliases?: string[];
}

export type PasteAction =
  /** A player coming in: the sender adding themselves, or a member of this
   *  month written into a numbered slot by somebody else. */
  | { kind: "in"; userId: string; name: string; self: boolean; slot: number | null }
  /** Moved under "Paid but can't play", their line blanked, or taken off
   *  the pasted bench. */
  | { kind: "out"; userId: string; name: string; self: boolean; via: "cant-play" | "blank" | "off-bench" }
  /** Written under the bench (Kemal, 2026-11-09): on the bench for this
   *  game, as a typed "put me on the bench". A squad player moved there
   *  gives up his place. */
  | { kind: "bench"; userId: string; name: string; self: boolean }
  /** A new "(paid)" mark on a regular's line: "says paid", never confirmed. */
  | { kind: "paid-claim"; userId: string; name: string; self: boolean; amountPence: number | null }
  /** Somebody who is not a member, written in by a member ("Jon extra",
   *  "David (my son)"), as the monthly reader read it: they play this week
   *  as a PAYG guest of `hostUserId`. The caller adds them the way a typed
   *  "David, my son, is IN" is added. */
  | { kind: "guest"; name: string; hostUserId: string | null; slot: number | null; bench?: true }
  /** AN ORGANISER'S new line in a running month (Kemal, 2026-11-03): a
   *  club member known by name who is not on the month. He joins it as a
   *  regular for the games left (PAYG when the line says), as "Add a
   *  player, Regular" on /admin/months does (`month-newcomers.ts`). */
  | { kind: "join"; userId: string; name: string; slot: number | null; line: NewcomerLine }
  /** An organiser's new line that is nobody of the club, and nobody brings
   *  him: a new player with no phone, who joins the month. The organiser is
   *  then asked whether he is a member with no name yet. */
  | { kind: "new"; name: string; slot: number | null; line: NewcomerLine }
  /** An organiser's new line the reader matched to a member with NO name
   *  yet (his WhatsApp name, or his number on the list): he could be the
   *  one, so nobody is added, and the organiser is asked who it is. */
  | { kind: "ask"; name: string; slot: number | null; candidateUserId: string | null; line: NewcomerLine };

/** A non-organiser's paste adds at most this many guests, and never more
 *  than the week's open places (review of #465). An organiser may fill
 *  the open places, up to the squad size. */
export const MAX_GUESTS_PER_PASTE = 3;

/** "4 only" beside a player of the month, as the reader read it. */
export interface PasteGames {
  userId: string;
  games: number;
  self: boolean;
}

export interface PasteIgnored {
  name: string;
  /** stale-readd: a paste re-adding a player who dropped (only the player
   *  themselves can come back by paste).
   *  blank-by-other: somebody else's line blanked, by neither them nor an admin.
   *  old-copy: a change to somebody else's line on a paste that is itself an
   *  old copy (it would bring back a dropped player), an admin's included. */
  reason: "stale-readd" | "blank-by-other" | "old-copy";
}

/** A name in a numbered slot that was NOT registered. A paste never
 *  creates a player and never guesses one. */
export interface PasteNotAdded {
  name: string;
  /** unknown: no player of this club has that name or alias.
   *  ambiguous: it fits more than one player.
   *  not-in-month: a club player who is not on this month's list, written
   *  in by somebody else (only they can add themselves). */
  reason: "unknown" | "ambiguous" | "not-in-month";
}

/** With no month header, this share of a list's names must be players of
 *  this month's list (or already on the week's match) for it to be read
 *  as the month's list at all. "Kit for Monday: 1. Bibs 2. Two balls" is
 *  a numbered list too. */
export const MIN_LIST_OVERLAP = 0.6;

/**
 * Compare a member's pasted list with this week's state, BY NAME, and say
 * what it changes. Nothing is written here.
 *
 * IS IT THE MONTH'S LIST AT ALL? Only with the month's header, or when at
 * least `MIN_LIST_OVERLAP` of its names are this month's players
 * (`notThisList` otherwise: nothing is read from it).
 *
 * WHO CAN BE ADDED. A paste never creates a player and never guesses:
 *  - the sender may add THEMSELVES (resolved by their own name or alias);
 *  - anybody may write in a member of THIS MONTH (a PAYG player of the
 *    month, a regular who has no row yet);
 *  - any other name (nobody's, two players', or a club player who is not
 *    on the month's list) is NOT registered and is reported (`notAdded`).
 *
 * WHO CAN BE TAKEN OUT, and the old copy.
 *  - a name moved under "Paid but can't play" is out, whoever pasted it
 *    (D4: the caller DMs the player an undo when it was somebody else);
 *  - a blanked line is an OUT only from the player themselves or an admin.
 *    Which player a blank was is read from the names either side of it,
 *    never from its number (`blankedPlayers`): the post counts 1, 2, 3;
 *  - a paste NEVER brings back a player who dropped, an admin's included:
 *    only the player's own paste does. A paste that tries is an OLD COPY,
 *    and an old copy changes nobody else's line at all, whoever sent it
 *    (it would undo what happened since). The sender's own line still
 *    applies;
 *  - a name that is simply missing, and reordered numbers, change nothing.
 *
 * THE BENCH (Kemal, 2026-11-09). A name written under the bench goes on it
 * for this game, by the rules a numbered line follows (who may write whom,
 * guests, a dropped player only by his own paste, a squad player moved
 * there as one moved under can't play). A bencher the paste's bench leaves
 * off comes off it: by his own paste, or an organiser's when the group had
 * already seen him on the bench (`benchSeen`), never on an old copy, and
 * never from a list written with no bench part at all.
 *
 * A paid mark is a claim, whoever wrote it (D3), and a missing mark
 * removes nothing.
 *
 * BEFORE THE WEEK IS SEEDED (`seeded: false`, the hours between one game
 * ending and the regulars being put on the next) only paid marks and the
 * sender's OWN in or out are read: nobody is brought in, taken out or
 * marked away by somebody else.
 */
export function reconcileMonthPaste(args: {
  list: MonthlyList;
  members: WeekMember[];
  rows: WeekRow[];
  maxPlayers: number;
  roster: PasteRosterMember[];
  /** 1 to 12: the month this week's match is in. */
  matchMonth: number;
  /** The month's regulars are on this match. */
  seeded: boolean;
  senderUserId: string | null;
  /** What the sender is called: their club name and their WhatsApp name. */
  senderNames?: Array<string | null | undefined>;
  senderIsAdmin: boolean;
  /** Before the seed only: may the sender's OWN in or out be applied to
   *  this (next) week? False when the paste is the list of the game just
   *  played (its title names that date, or it is that game's list with
   *  nothing changed but paid marks): the line was about that game, and
   *  only paid marks are read. Default true. */
  selfBeforeSeed?: boolean;
  /** Who was already on the bench when the group last saw the list: an
   *  organiser's paste that leaves one of them off the bench takes him
   *  off. Anybody else could be missing only because the copy is older
   *  than him. Default: nobody. */
  benchSeen?: ReadonlySet<string>;
}): {
  actions: PasteAction[];
  ignored: PasteIgnored[];
  notAdded: PasteNotAdded[];
  games: PasteGames[];
  /** Guests past the cap: nobody added for them; the sender is told. */
  guestsRefused: string[];
  otherMonth: boolean;
  notThisList: boolean;
} {
  const { list, members, rows, senderUserId, senderIsAdmin } = args;
  const nothing = { actions: [], ignored: [], notAdded: [], games: [], guestsRefused: [] };
  if (list.month && list.month.month !== args.matchMonth) return { ...nothing, otherMonth: true, notThisList: false };

  const memberOf = new Map(members.map((m) => [m.userId, m]));
  const rowOf = new Map(rows.map((r) => [r.userId, r]));
  const known = new Set<string>([...memberOf.keys(), ...rowOf.keys()]);
  const resolve = entryResolver(args.roster, known);

  const named = (entries: MonthlyListEntry[]) => entries.filter((e) => e.name).map((e) => ({ e, r: resolve(e) }));
  const slotLines = named(list.slots);
  const cantLines = named(list.sections.cantPlay);
  const benchLines = named(list.sections.reserves);
  const elsewhere = [...benchLines, ...named(list.sections.other)];
  // The paste shows a bench (its part may be empty: the last name taken off).
  const benchShown = list.benchShown ?? list.sections.reserves.length > 0;

  if (!list.month) {
    const lines = [...slotLines, ...cantLines];
    const ours = lines.filter((x) => x.r.kind === "one" && known.has(x.r.userId)).length;
    if (lines.length === 0 || ours / lines.length < MIN_LIST_OVERLAP) return { ...nothing, otherMonth: false, notThisList: true };
  }

  const onPaste = new Set<string>();
  for (const { r } of [...slotLines, ...cantLines, ...elsewhere]) if (r.kind === "one") onPaste.add(r.userId);
  // UNCLEAR LINES (review of #574, round 3): who-is-who could not place
  // them. Whoever they could be may be on the paste, so nobody they could
  // be is taken off for missing from it; a line that could be anybody (no
  // answer) takes nobody but the sender off.
  const maybeOnPaste = new Set<string>(onPaste);
  let anybodyMaybeOnPaste = false;
  for (const { e } of [...slotLines, ...cantLines, ...elsewhere]) {
    const u = e.facts?.unclear;
    if (!u) continue;
    if (u.candidates.length === 0) anybodyMaybeOnPaste = true;
    for (const id of u.candidates) maybeOnPaste.add(id);
  }
  const mayBeOnPaste = (userId: string): boolean => anybodyMaybeOnPaste || maybeOnPaste.has(userId);
  const week = buildWeekList(args);
  const isOutNow = (userId: string): boolean => {
    const row = rowOf.get(userId);
    const m = memberOf.get(userId);
    return row ? row.status === "DROPPED" : m?.kind === "regular" && m.absent === true;
  };

  // An OLD COPY: it has somebody in a numbered slot who has since dropped
  // (and it is not that player's own paste).
  const oldCopy = slotLines.some((x) => x.r.kind === "one" && x.r.userId !== senderUserId && isOutNow(x.r.userId));

  const actions: PasteAction[] = [];
  const ignored: PasteIgnored[] = [];
  const notAdded: PasteNotAdded[] = [];
  const games: PasteGames[] = [];
  const handled = new Set<string>();
  const senderIsClubPlayer = !!senderUserId && args.roster.some((m) => m.userId === senderUserId);
  // Guests: never more than the open places; a non-organiser at most the cap.
  const openPlaces = Math.max(0, args.maxPlayers - rows.filter((r) => r.status === "CONFIRMED").length);
  const guestCap = senderIsAdmin ? openPlaces : Math.min(openPlaces, MAX_GUESTS_PER_PASTE);
  let guestsAdded = 0;
  let newPlayers = 0;
  const guestsRefused: string[] = [];
  const gamesOf = (e: MonthlyListEntry, userId: string): void => {
    const g = e.facts?.games ?? null;
    if (g !== null && memberOf.get(userId)?.kind === "regular") games.push({ userId, games: g, self: userId === senderUserId });
  };

  const claimIfNew = (e: MonthlyListEntry, userId: string): void => {
    const m = memberOf.get(userId);
    if (!e.marks.paid || e.marks.payg || m?.kind !== "regular" || m.paid !== "none") return;
    actions.push({ kind: "paid-claim", userId, name: e.name, self: userId === senderUserId, amountPence: e.marks.paidAmountPence });
  };

  // THE SENDER WRITING THEMSELVES IN UNDER A NAME WE DO NOT HAVE ("Big
  // Gary"). Narrow on purpose, so it can never act on the wrong person:
  // the sender is a known club player, is not on the paste and not on the
  // match, the paste has exactly ONE line that matches nobody, and that
  // line carries the sender's FIRST name (of their club name or of their
  // WhatsApp name) as a whole word, or is their whole name. A surname
  // alone is not enough: brothers share one.
  const senderRowNow = senderUserId ? rowOf.get(senderUserId) : undefined;
  const senderKeys = (args.senderNames ?? []).map((n) => nameKey(n)).filter(Boolean);
  const senderWords = new Set(senderKeys.map((k) => k.split(" ")[0]).filter((w) => w.length >= 2));
  const unknownLines = slotLines.filter((x) => x.r.kind === "none");
  const selfLine =
    senderUserId &&
    args.roster.some((m) => m.userId === senderUserId) &&
    !onPaste.has(senderUserId) &&
    senderRowNow?.status !== "CONFIRMED" &&
    senderRowNow?.status !== "BENCH" &&
    unknownLines.length === 1 &&
    (senderKeys.includes(nameKey(unknownLines[0].e.name)) ||
      nameKey(unknownLines[0].e.name)
        .split(" ")
        .some((w) => senderWords.has(w)))
      ? unknownLines[0].e
      : null;

  for (const { e, r } of slotLines) {
    if (r.kind !== "one") {
      if (e === selfLine && senderUserId) {
        handled.add(senderUserId);
        actions.push({ kind: "in", userId: senderUserId, name: e.name, self: true, slot: e.slot });
      } else if (r.kind === "ambiguous") {
        // Not placed on one member, nor nobody: never a new person, and no
        // guest place used (review of #574, round 3).
        notAdded.push({ name: e.name, reason: "ambiguous" });
      } else if (e.facts?.guest && senderIsAdmin && !e.facts.hostUserId) {
        // An organiser's new line for somebody who is nobody of the club
        // and whom nobody brings: a new player of the month (Kemal,
        // 2026-11-03). A few per paste; more is likely a misread.
        if (newPlayers < MAX_NEW_PLAYERS_PER_PASTE) {
          newPlayers++;
          actions.push({ kind: "new", name: e.name, slot: e.slot, line: newcomerLineOf(e) });
        } else {
          guestsRefused.push(e.name);
        }
      } else if (e.facts?.guest && senderIsClubPlayer) {
        // B2: a member's guest. Nobody of the club (the reader matched
        // nobody), so a new player, brought by the host: up to the cap.
        if (guestsAdded < guestCap) {
          guestsAdded++;
          actions.push({ kind: "guest", name: e.name, hostUserId: e.facts.hostUserId ?? senderUserId, slot: e.slot });
        } else {
          guestsRefused.push(e.name);
        }
      } else {
        notAdded.push({ name: e.name, reason: r.kind === "none" ? "unknown" : "ambiguous" });
      }
      continue;
    }
    const userId = r.userId;
    if (handled.has(userId)) continue;
    handled.add(userId);
    const self = userId === senderUserId;
    const row = rowOf.get(userId);
    if (isOutNow(userId)) {
      if (self) actions.push({ kind: "in", userId, name: e.name, self, slot: e.slot });
      else ignored.push({ name: e.name, reason: "stale-readd" });
    } else if (!row) {
      // A club player who is not on the month comes in only when he is
      // the sender (a member ref is never a guest, review of #465).
      if (self || memberOf.has(userId)) actions.push({ kind: "in", userId, name: e.name, self, slot: e.slot });
      // An ORGANISER's line brings him onto the month (Kemal, 2026-11-03):
      // a member known by name joins; one with no name yet the reader
      // matched could be him, and the organiser is asked first.
      else if (senderIsAdmin) {
        const line = newcomerLineOf(e);
        actions.push(
          isNamedMember(args.roster.find((m) => m.userId === userId))
            ? { kind: "join", userId, name: e.name, slot: e.slot, line }
            : { kind: "ask", name: e.name, slot: e.slot, candidateUserId: userId, line },
        );
      } else notAdded.push({ name: e.name, reason: "not-in-month" });
    }
    claimIfNew(e, userId);
    gamesOf(e, userId);
  }

  for (const { e, r } of cantLines) {
    if (r.kind !== "one" || handled.has(r.userId)) continue;
    const userId = r.userId;
    handled.add(userId);
    const self = userId === senderUserId;
    const row = rowOf.get(userId);
    const m = memberOf.get(userId);
    const playing = row ? row.status !== "DROPPED" : m?.kind === "regular" && !m.absent;
    if (playing) {
      if (self || !oldCopy) actions.push({ kind: "out", userId, name: e.name, self, via: "cant-play" });
      else ignored.push({ name: e.name, reason: "old-copy" });
    }
    claimIfNew(e, userId);
    gamesOf(e, userId);
  }

  // THE BENCH (Kemal, 2026-11-09). A name written under it is on the bench
  // for this game, by the same rules as a numbered line: the sender
  // himself, anybody for a player of this month, an organiser for any club
  // player; a guest as on a numbered line; never a player who dropped
  // unless it is his own paste; a squad player moved there as one moved
  // under can't play. Guests on the bench take no place, so they are
  // capped per paste only.
  let benchGuests = 0;
  const benchGuestCap = senderIsAdmin ? MAX_NEW_PLAYERS_PER_PASTE : MAX_GUESTS_PER_PASTE;
  for (const { e, r } of benchLines) {
    if (r.kind !== "one") {
      if (r.kind === "none" && e.facts?.guest && (senderIsClubPlayer || senderIsAdmin)) {
        if (benchGuests < benchGuestCap) {
          benchGuests++;
          actions.push({ kind: "guest", name: e.name, hostUserId: e.facts.hostUserId ?? (senderIsAdmin ? null : senderUserId), slot: e.slot, bench: true });
        } else {
          guestsRefused.push(e.name);
        }
      } else {
        notAdded.push({ name: e.name, reason: r.kind === "none" ? "unknown" : "ambiguous" });
      }
      continue;
    }
    const userId = r.userId;
    if (handled.has(userId)) continue;
    handled.add(userId);
    const self = userId === senderUserId;
    const row = rowOf.get(userId);
    const m = memberOf.get(userId);
    if (row?.status !== "BENCH") {
      if (isOutNow(userId)) {
        if (self) actions.push({ kind: "bench", userId, name: e.name, self });
        else ignored.push({ name: e.name, reason: "stale-readd" });
      } else if (row ? row.status === "CONFIRMED" : m?.kind === "regular") {
        if (self || !oldCopy) actions.push({ kind: "bench", userId, name: e.name, self });
        else ignored.push({ name: e.name, reason: "old-copy" });
      } else if (self || memberOf.has(userId) || senderIsAdmin) {
        actions.push({ kind: "bench", userId, name: e.name, self });
      } else {
        notAdded.push({ name: e.name, reason: "not-in-month" });
      }
    }
    claimIfNew(e, userId);
    gamesOf(e, userId);
  }

  // A bencher the paste's bench leaves off, who is nowhere else on it. Only
  // when the paste shows a bench at all (an empty one too): a list written
  // without one says nothing about the bench.
  if (benchShown) {
    for (const b of week.reserves) {
      if (onPaste.has(b.userId) || handled.has(b.userId)) continue;
      const self = b.userId === senderUserId;
      // An unclear line may be him (round 3): not "left off" by anybody else.
      if (!self && mayBeOnPaste(b.userId)) continue;
      handled.add(b.userId);
      if (self) actions.push({ kind: "out", userId: b.userId, name: b.name, self, via: "off-bench" });
      else if (!senderIsAdmin) ignored.push({ name: b.name, reason: "blank-by-other" });
      else if (oldCopy) ignored.push({ name: b.name, reason: "old-copy" });
      else if (args.benchSeen?.has(b.userId)) actions.push({ kind: "out", userId: b.userId, name: b.name, self, via: "off-bench" });
      // Else he joined the bench after the list the group last saw: the
      // copy may be older than him, and nothing is done.
    }
  }

  // A numbered line left blank where we have somebody, who is nowhere else
  // on the paste.
  for (const held of blankedPlayers(list, week, resolve, onPaste)) {
    if (handled.has(held.userId)) continue;
    const self = held.userId === senderUserId;
    // An unclear line may be him (round 3): his line is not blank.
    if (!self && mayBeOnPaste(held.userId)) continue;
    handled.add(held.userId);
    if (self || (senderIsAdmin && !oldCopy)) {
      actions.push({ kind: "out", userId: held.userId, name: held.name, self, via: "blank" });
    } else {
      ignored.push({ name: held.name, reason: senderIsAdmin ? "old-copy" : "blank-by-other" });
    }
  }

  // Before the seed the week has no squad for anybody to change on
  // somebody else's behalf: paid marks, and the SENDER'S OWN in or out,
  // which the caller records so the seed honours it (an early IN is a row
  // the seed keeps; a regular's early OUT is an away week).
  if (!args.seeded) {
    return {
      actions: actions.filter((a) => {
        if (a.kind === "paid-claim") return true;
        // An organiser's new line waits for the seed, like a guest.
        if (a.kind === "guest" || a.kind === "join" || a.kind === "new" || a.kind === "ask") return false;
        // The bench is this game's, and the game has no squad yet.
        if (a.kind === "bench" || (a.kind === "out" && a.via === "off-bench")) return false;
        if (!a.self || args.selfBeforeSeed === false) return false;
        // A regular who is not away is put in by the seed anyway.
        const m = memberOf.get(a.userId);
        return !(a.kind === "in" && m?.kind === "regular" && !m.absent);
      }),
      ignored: [],
      notAdded: [],
      games,
      guestsRefused: [],
      otherMonth: false,
      notThisList: false,
    };
  }
  return { actions, ignored, notAdded, games, guestsRefused, otherMonth: false, notThisList: false };
}

/**
 * Who a pasted list's BLANK numbered lines took off, read by where each
 * blank sits among the names around it, never by its number (2026-11-07:
 * the week's post numbers its lines 1, 2, 3, so a printed number is no
 * longer a slot number, and a copy from before then still carries them).
 *
 * The group writes the list two ways: as MatchTime posts it (the squad,
 * then pay as you go: `weekListPlaces`) and in its own format (everybody
 * with a place in slot order, PAYG players among them). A paste is read
 * in each way its names follow, in order. A run of blank lines sits
 * between two named lines (or the top or the end of the list), and the
 * players it can be are those placed between those two names, in a way
 * the paste follows, who are nowhere on the paste. When the run has at
 * least as many lines as there are such players, each of them is a
 * blanked line. When it has fewer, the players EVERY reading puts there
 * are, if the run has room for them; otherwise some may simply be missing
 * (which changes nothing) and nobody can say which, so nobody is taken off.
 */
function blankedPlayers(
  list: MonthlyList,
  week: WeekList,
  resolve: (e: MonthlyListEntry) => Resolved,
  onPaste: ReadonlySet<string>,
): PlacedWeekSlot[] {
  const { squad, payg } = weekListPlaces(week);
  const posted = [...squad, ...payg];
  const bySlot = [...posted].sort((a, b) => a.slot - b.slot);
  const lines = list.slots;
  const idOf = lines.map((e) => {
    if (!e.name) return null;
    const r = resolve(e);
    return r.kind === "one" ? r.userId : null;
  });
  // The ways of writing it that the paste's names follow, in order.
  const readings = [posted, bySlot]
    .map((order) => ({ order, at: new Map(order.map((s, i) => [s.userId, i])) }))
    .filter(({ at }) => {
      let last = -1;
      for (const id of idOf) {
        const i = id === null ? undefined : at.get(id);
        if (i === undefined) continue;
        if (i <= last) return false;
        last = i;
      }
      return true;
    });
  const isBlank = (e: MonthlyListEntry): boolean => !e.name && e.slot != null;

  const out: PlacedWeekSlot[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!isBlank(lines[i])) {
      i++;
      continue;
    }
    let end = i;
    while (end < lines.length && isBlank(lines[end])) end++;
    const run = end - i;
    const each: Array<Set<string>> = [];
    const missing = new Map<string, PlacedWeekSlot>();
    for (const { order, at } of readings) {
      // The nearest named line either side that is somebody placed.
      const near = (from: number, step: -1 | 1): number | null => {
        for (let k = from; k >= 0 && k < lines.length; k += step) {
          const id = idOf[k];
          const pos = id === null ? undefined : at.get(id);
          if (pos !== undefined) return pos;
        }
        return null;
      };
      const before = near(i - 1, -1);
      const after = near(end, 1);
      if (before === null && after === null) continue;
      const here = order.slice(before === null ? 0 : before + 1, after === null ? order.length : after).filter((s) => !onPaste.has(s.userId));
      for (const s of here) missing.set(s.userId, s);
      each.push(new Set(here.map((s) => s.userId)));
    }
    i = end;
    // Who any reading puts there; when that is more players than blank
    // lines, who every reading puts there.
    const any = [...missing.values()];
    const all = any.filter((s) => each.every((set) => set.has(s.userId)));
    const taken = any.length <= run ? any : all.length <= run ? all : [];
    out.push(...taken);
  }
  return out;
}

/**
 * Does this paste show the list as MatchTime has it? Then the group has
 * just seen the current list and MatchTime does not post it again
 * (plan 5.4). Compared by who has a place and who can't play, never by
 * the numbers written (2026-11-07: the post numbers its lines 1, 2, 3, not
 * by slot, and a copy from before then has slot numbers); paid marks are
 * not compared (a member's copy may lack one).
 */
export function pasteShowsSameList(args: { list: MonthlyList; week: WeekList; roster: PasteRosterMember[] }): boolean {
  const { list, week } = args;
  const known = new Set<string>([
    ...week.slots.map((s) => s.userId).filter((u): u is string => u !== null),
    ...week.paidCantPlay.map((n) => n.userId),
    ...week.cantPlay.map((n) => n.userId),
    ...week.reserves.map((n) => n.userId),
  ]);
  const resolve = entryResolver(args.roster, known);
  const who = (e: MonthlyListEntry): string => {
    const r = resolve(e);
    return r.kind === "one" ? r.userId : `?${nameKey(e.name)}`;
  };

  // Each person once, each on a numbered line.
  const pasted = new Set<string>();
  for (const e of list.slots) {
    if (!e.name) continue;
    const id = who(e);
    if (e.slot == null || pasted.has(id)) return false;
    pasted.add(id);
  }
  const { squad, payg } = weekListPlaces(week);
  const ours = [...squad, ...payg].map((s) => s.userId);
  if (pasted.size !== ours.length) return false;
  for (const userId of ours) if (!pasted.has(userId)) return false;

  const pastedOut = new Set(list.sections.cantPlay.filter((e) => e.name).map(who));
  const oursOut = new Set([...week.paidCantPlay, ...week.cantPlay].map((n) => n.userId));
  if (pastedOut.size !== oursOut.size) return false;
  for (const u of oursOut) if (!pastedOut.has(u)) return false;

  // The bench, when the paste shows one (2026-11-09: a name added or taken
  // off there is a change). A list written without a bench is not compared.
  if (list.benchShown ?? list.sections.reserves.length > 0) {
    const pastedBench = new Set(list.sections.reserves.filter((e) => e.name).map(who));
    if (pastedBench.size !== week.reserves.length) return false;
    for (const n of week.reserves) if (!pastedBench.has(n.userId)) return false;
  }
  return true;
}

// ── The collector's reply to an unstaged fee question ──────────────────

/** "A short window right after the ask." */
export const FEE_REPLY_WINDOW_MS = 15 * 60 * 1000;

/**
 * The collector DMed MatchTime while a monthly match has a PAYG fee
 * question out whose amount was never staged (its ack was lost). May
 * their reply stage the PAYG price, so that it then confirms it?
 *
 * ONLY when every one of these holds. Anything else does nothing, and the
 * collector sets a fee by typing an amount, as in the weekly flow.
 *
 *   - the reply is a yes to the fee question, as the fee reader (a model,
 *     `fee-confirm.ts`) read it. An amount is not this
 *     path's business: the weekly path stages the amount they typed;
 *   - the question was handed to the Pi (`askedAt`), and is not known to
 *     have FAILED (`unsent`: the Pi acked it with no message id);
 *   - the collector has not already declined it;
 *   - the yes comes within `FEE_REPLY_WINDOW_MS` of the question, and
 *     MatchTime has sent the collector no other DM since, so the yes
 *     cannot be an answer to something else.
 */
export function mayStagePaygFeeOnReply(p: {
  reply: "yes" | "no" | null;
  askedAt: Date | null;
  unsent: boolean;
  declined: boolean;
  otherDmSinceAsk: boolean;
  now: Date;
}): boolean {
  if (p.reply !== "yes" || !p.askedAt || p.unsent || p.declined || p.otherDmSinceAsk) return false;
  const age = p.now.getTime() - p.askedAt.getTime();
  return age >= 0 && age <= FEE_REPLY_WINDOW_MS;
}
