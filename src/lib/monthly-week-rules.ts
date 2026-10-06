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
import type { MonthlyList, MonthlyListEntry } from "./monthly-list";
import { candidatesFor, nameKey, type MonthCreditRule } from "./squad-month-rules";

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
}

/** One Attendance row on this week's match. */
export interface WeekRow {
  userId: string;
  name: string;
  status: WeekStatus;
  position: number;
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
export const SEED_NOTE_NO_PLACE = "regular of the month: no place left";
export const SEED_NOTE_PAYG = "PAYG for this date";

/**
 * Who is written onto this week's match from the month.
 *
 *  - every regular, in slot order, at `position = slot`: CONFIRMED while
 *    there is room, the waiting list after that;
 *  - a regular who said they are away this week is written OUT, so the
 *    list shows them under "Paid but can't play" from the start;
 *  - a PAYG player only on a date they named;
 *  - anyone who already has a row is NOT touched: an early OUT stays OUT
 *    and an early IN is not duplicated. A regular's existing row is only
 *    marked as paid for by the month (`markMonthly`).
 */
export function decideMonthlySeed(args: {
  members: WeekMember[];
  targetRows: Array<{ userId: string; status: string }>;
  maxPlayers: number;
}): { write: MonthlySeedWrite[]; markMonthly: string[] } {
  const onTarget = new Set(args.targetRows.map((r) => r.userId));
  let room = Math.max(0, args.maxPlayers - args.targetRows.filter((r) => r.status === "CONFIRMED").length);
  const bySlot = (a: WeekMember, b: WeekMember): number =>
    (a.slot ?? Number.MAX_SAFE_INTEGER) - (b.slot ?? Number.MAX_SAFE_INTEGER) || a.userId.localeCompare(b.userId);
  const regulars = args.members.filter((m) => m.kind === "regular").sort(bySlot);
  const dated = args.members.filter((m) => m.kind === "payg" && m.paygDated).sort(bySlot);

  const taken = new Set<number>(regulars.map((m) => m.slot).filter((s): s is number => s != null));
  let next = 1;
  const freeNumber = (): number => {
    while (taken.has(next)) next++;
    taken.add(next);
    return next;
  };

  const write: MonthlySeedWrite[] = [];
  const markMonthly: string[] = [];
  for (const m of regulars) {
    if (onTarget.has(m.userId)) {
      markMonthly.push(m.userId);
      continue;
    }
    const position = m.slot ?? freeNumber();
    if (m.absent) {
      write.push({ userId: m.userId, status: "DROPPED", position, monthly: true, note: SEED_NOTE_AWAY });
    } else if (room > 0) {
      room--;
      write.push({ userId: m.userId, status: "CONFIRMED", position, monthly: true, note: SEED_NOTE_REGULAR });
    } else {
      write.push({ userId: m.userId, status: "BENCH", position, monthly: true, note: SEED_NOTE_NO_PLACE });
    }
  }
  for (const m of dated) {
    if (onTarget.has(m.userId)) continue;
    const position = m.slot != null && !taken.has(m.slot) ? (taken.add(m.slot), m.slot) : freeNumber();
    const status: WeekStatus = room > 0 ? "CONFIRMED" : "BENCH";
    if (room > 0) room--;
    write.push({ userId: m.userId, status, position, monthly: false, note: SEED_NOTE_PAYG });
  }
  return { write, markMonthly };
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
    if (m?.kind !== "regular") return "payg";
    return m.paid === "none" ? null : "paid";
  };

  // A regular who has not answered yet (no row, not away) keeps their slot.
  const kept = new Set<number>();
  for (const m of members) {
    if (m.kind === "regular" && m.slot != null && !m.absent && !rowOf.has(m.userId)) kept.add(m.slot);
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
    .filter((m) => m.kind === "regular")
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
 *   any-miss      every game a paid (or says-paid) regular misses, a late
 *                 drop included;
 *   filled-only   only while somebody else holds their slot;
 *   none          never.
 *
 * `create`: regulars who should have a credit and have none. A credit an
 * admin voided is never written again.
 * `voidIds`: credits MatchTime wrote itself that no longer hold (the
 * regular came back), unless they have already been used against a month.
 */
export function decideMissedCredits(args: {
  rule: MonthCreditRule;
  members: WeekMember[];
  rows: WeekRow[];
  maxPlayers: number;
  existing: MissedCreditRow[];
}): { create: string[]; voidIds: string[] } {
  const rowOf = new Map(args.rows.map((r) => [r.userId, r]));
  const list = args.rule === "filled-only" ? buildWeekList(args) : null;
  const entitled = new Set<string>();
  for (const m of args.members) {
    if (m.kind !== "regular" || m.paid === "none") continue;
    if (!isOut(m, rowOf.get(m.userId))) continue;
    if (args.rule === "none") continue;
    if (args.rule === "filled-only") {
      const holder = list!.slots.find((s) => s.slot === m.slot)?.userId ?? null;
      if (holder === null || holder === m.userId) continue;
    }
    entitled.add(m.userId);
  }

  const create: string[] = [];
  for (const userId of entitled) {
    const mine = args.existing.filter((e) => e.userId === userId);
    if (mine.some((e) => e.voidedAt === null)) continue;
    if (mine.some((e) => e.voidedById !== null)) continue;
    create.push(userId);
  }
  const voidIds = args.existing
    .filter((e) => e.voidedAt === null && !entitled.has(e.userId) && e.appliedMonthId === null && e.createdById === null)
    .map((e) => e.id);
  return { create, voidIds };
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
const LIST_FROM_HOUR = 8;
const LIST_QUIET_FROM_HOUR = 22;
const MORNING_UNTIL_HOUR = 12;

/**
 * Is a list post due?
 *
 *   "change"   the list differs from the one the group last saw (a post of
 *              ours, or a member's paste that matched our state);
 *   "morning"  match morning, 08:00 to 11:59 London, once, whatever else;
 *   null       nothing to post.
 *
 * Never between 22:00 and 07:59 London, never within 30 minutes of the
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
}): "change" | "morning" | null {
  if (!p.live || !p.nextUpcoming || p.teamsOut) return null;
  if (p.now.getTime() >= p.matchDate.getTime()) return null;
  const hour = Number(formatLondon(p.now, "H"));
  if (hour < LIST_FROM_HOUR || hour >= LIST_QUIET_FROM_HOUR) return null;
  if (p.lastPostAt && p.now.getTime() - p.lastPostAt.getTime() < LIST_REPOST_FLOOR_MS) return null;
  if (p.hash !== p.lastShownHash) return "change";

  const matchDay = formatLondon(p.matchDate, "yyyy-MM-dd");
  if (formatLondon(p.now, "yyyy-MM-dd") !== matchDay || hour >= MORNING_UNTIL_HOUR) return null;
  const morningStart = londonDateTimeToUtc(matchDay, "08:00");
  if (p.lastPostAt && p.lastPostAt.getTime() >= morningStart.getTime()) return null;
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
  /** A new name in a numbered slot, or a player coming back. `userId`
   *  null: a name nobody here has, for the caller to resolve or provision.
   *  `teachAlias`: the sender wrote themselves under a name we did not know. */
  | { kind: "in"; userId: string | null; name: string; self: boolean; slot: number | null; teachAlias: string | null }
  /** Moved under "Paid but can't play", or their line blanked. */
  | { kind: "out"; userId: string; name: string; self: boolean; via: "cant-play" | "blank" }
  /** A new "(paid)" mark on a regular's line: "says paid", never confirmed. */
  | { kind: "paid-claim"; userId: string; name: string; self: boolean; amountPence: number | null };

export interface PasteIgnored {
  name: string;
  /** stale-readd: an old copy re-adding a player who dropped.
   *  blank-by-other: somebody else's line blanked, by neither them nor an admin.
   *  ambiguous: the name fits more than one player. */
  reason: "stale-readd" | "blank-by-other" | "ambiguous";
}

type Resolved = { kind: "one"; userId: string } | { kind: "none" } | { kind: "ambiguous" };

/** Name to player: the whole name, a known alias, then the leading name
 *  (`candidatesFor`, the mid-month seed's matcher). Two candidates are
 *  narrowed to the ones already part of this week; still two is ambiguous. */
function makeResolver(roster: PasteRosterMember[], known: ReadonlySet<string>): (name: string) => Resolved {
  const keyed = roster.map((m) => ({ userId: m.userId, key: nameKey(m.name), aliasKeys: (m.aliases ?? []).map(nameKey) }));
  return (name: string): Resolved => {
    const key = nameKey(name);
    if (key === "") return { kind: "none" };
    let found = [...new Set(candidatesFor(key, keyed))];
    if (found.length > 1) {
      const narrowed = found.filter((id) => known.has(id));
      if (narrowed.length === 1) found = narrowed;
    }
    if (found.length === 0) return { kind: "none" };
    return found.length === 1 ? { kind: "one", userId: found[0] } : { kind: "ambiguous" };
  };
}

/**
 * Compare a member's pasted list with this week's state, BY NAME, and say
 * what it changes. Nothing is written here.
 *
 *  - a new name in a numbered slot is in for this week (capacity decides
 *    between a place and the waiting list when it is applied);
 *  - a name moved under "Paid but can't play" is out, whoever pasted it
 *    (D4: the caller DMs the player an undo when it was somebody else);
 *  - a blanked line is an OUT only from the player themselves or an
 *    admin. From anyone else it is indistinguishable from an old copy;
 *  - a paste can only move a person FORWARD: it never brings back a
 *    player who dropped (unless they or an admin pasted it) and never
 *    removes a paid mark;
 *  - a name that is simply missing, and reordered numbers, change nothing;
 *  - a paid mark is a claim, whoever wrote it (D3).
 */
export function reconcileMonthPaste(args: {
  list: MonthlyList;
  members: WeekMember[];
  rows: WeekRow[];
  maxPlayers: number;
  roster: PasteRosterMember[];
  /** 1 to 12: the month this week's match is in. */
  matchMonth: number;
  senderUserId: string | null;
  senderIsAdmin: boolean;
}): { actions: PasteAction[]; ignored: PasteIgnored[]; otherMonth: boolean } {
  const { list, members, rows, senderUserId, senderIsAdmin } = args;
  if (list.month && list.month.month !== args.matchMonth) return { actions: [], ignored: [], otherMonth: true };

  const memberOf = new Map(members.map((m) => [m.userId, m]));
  const rowOf = new Map(rows.map((r) => [r.userId, r]));
  const known = new Set<string>([...memberOf.keys(), ...rowOf.keys()]);
  const resolve = makeResolver(args.roster, known);
  const week = buildWeekList(args);

  const named = (entries: MonthlyListEntry[]) => entries.filter((e) => e.name).map((e) => ({ e, r: resolve(e.name) }));
  const slotLines = named(list.slots);
  const cantLines = named(list.sections.cantPlay);
  const elsewhere = [...named(list.sections.reserves), ...named(list.sections.other)];
  const onPaste = new Set<string>();
  for (const { r } of [...slotLines, ...cantLines, ...elsewhere]) if (r.kind === "one") onPaste.add(r.userId);

  const senderRow = senderUserId ? rowOf.get(senderUserId) : undefined;
  const senderPlaying = senderRow?.status === "CONFIRMED" || senderRow?.status === "BENCH";
  const unknownSlotLines = slotLines.filter((x) => x.r.kind === "none").length;
  const mayAct = (userId: string): boolean => senderIsAdmin || userId === senderUserId;

  const actions: PasteAction[] = [];
  const ignored: PasteIgnored[] = [];
  const handled = new Set<string>();

  const claimIfNew = (e: MonthlyListEntry, userId: string): void => {
    const m = memberOf.get(userId);
    if (!e.marks.paid || e.marks.payg || m?.kind !== "regular" || m.paid !== "none") return;
    actions.push({ kind: "paid-claim", userId, name: e.name, self: userId === senderUserId, amountPence: e.marks.paidAmountPence });
  };

  for (const { e, r } of slotLines) {
    if (r.kind === "ambiguous") {
      ignored.push({ name: e.name, reason: "ambiguous" });
      continue;
    }
    if (r.kind === "none") {
      // The sender writing themselves in under a name we do not know.
      if (senderUserId && !onPaste.has(senderUserId) && !senderPlaying && unknownSlotLines === 1 && !handled.has(senderUserId)) {
        handled.add(senderUserId);
        actions.push({ kind: "in", userId: senderUserId, name: e.name, self: true, slot: e.slot, teachAlias: e.name });
      } else {
        actions.push({ kind: "in", userId: null, name: e.name, self: false, slot: e.slot, teachAlias: null });
      }
      continue;
    }
    const userId = r.userId;
    if (handled.has(userId)) continue;
    handled.add(userId);
    const row = rowOf.get(userId);
    const m = memberOf.get(userId);
    const out = row ? row.status === "DROPPED" : m?.kind === "regular" && m.absent;
    if (out) {
      if (mayAct(userId)) {
        actions.push({ kind: "in", userId, name: e.name, self: userId === senderUserId, slot: e.slot, teachAlias: null });
      } else {
        ignored.push({ name: e.name, reason: "stale-readd" });
      }
    } else if (!row) {
      actions.push({ kind: "in", userId, name: e.name, self: userId === senderUserId, slot: e.slot, teachAlias: null });
    }
    claimIfNew(e, userId);
  }

  for (const { e, r } of cantLines) {
    if (r.kind === "ambiguous") {
      ignored.push({ name: e.name, reason: "ambiguous" });
      continue;
    }
    if (r.kind !== "one" || handled.has(r.userId)) continue;
    const userId = r.userId;
    handled.add(userId);
    const row = rowOf.get(userId);
    const m = memberOf.get(userId);
    const playing = row ? row.status !== "DROPPED" : m?.kind === "regular" && !m.absent;
    if (playing) actions.push({ kind: "out", userId, name: e.name, self: userId === senderUserId, via: "cant-play" });
    claimIfNew(e, userId);
  }

  // A numbered line left blank where we have somebody, who is nowhere else
  // on the paste.
  for (const e of list.slots) {
    if (e.name || e.slot == null) continue;
    const held = week.slots.find((s) => s.slot === e.slot);
    if (!held?.userId || onPaste.has(held.userId) || handled.has(held.userId)) continue;
    handled.add(held.userId);
    if (mayAct(held.userId)) {
      actions.push({ kind: "out", userId: held.userId, name: held.name, self: held.userId === senderUserId, via: "blank" });
    } else {
      ignored.push({ name: held.name, reason: "blank-by-other" });
    }
  }

  return { actions, ignored, otherMonth: false };
}

/**
 * Does this paste show the list as MatchTime has it? Then the group has
 * just seen the current list and MatchTime does not post it again
 * (plan 5.4). Compared by who is in which slot and who can't play; paid
 * marks are not compared (a member's copy may lack one).
 */
export function pasteShowsSameList(args: { list: MonthlyList; week: WeekList; roster: PasteRosterMember[] }): boolean {
  const { list, week } = args;
  const known = new Set<string>([
    ...week.slots.map((s) => s.userId).filter((u): u is string => u !== null),
    ...week.paidCantPlay.map((n) => n.userId),
    ...week.cantPlay.map((n) => n.userId),
    ...week.reserves.map((n) => n.userId),
  ]);
  const resolve = makeResolver(args.roster, known);
  const who = (e: MonthlyListEntry): string => {
    const r = resolve(e.name);
    return r.kind === "one" ? r.userId : `?${nameKey(e.name)}`;
  };

  const pasted = new Map<number, string>();
  for (const e of list.slots) {
    if (!e.name) continue;
    if (e.slot == null || pasted.has(e.slot)) return false;
    pasted.set(e.slot, who(e));
  }
  const ours = new Map<number, string>();
  for (const s of week.slots) if (s.userId) ours.set(s.slot, s.userId);
  if (pasted.size !== ours.size) return false;
  for (const [slot, userId] of ours) if (pasted.get(slot) !== userId) return false;

  const pastedOut = new Set(list.sections.cantPlay.filter((e) => e.name).map(who));
  const oursOut = new Set([...week.paidCantPlay, ...week.cantPlay].map((n) => n.userId));
  if (pastedOut.size !== oursOut.size) return false;
  for (const u of oursOut) if (!pastedOut.has(u)) return false;
  return true;
}
