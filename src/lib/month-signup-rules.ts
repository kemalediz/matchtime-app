/**
 * Monthly squad, slice 3: the month opens and people sign up. The pure
 * rules (2026-10-06).
 * Plan: MDs/monthly-squad-plan-2026-10-05.md, sections 4.1 and 6.2, with
 * the paste rules slice 5 settled after review ("Changed after review").
 *
 *   WHEN   `listOpensAt` / `listOpenDue`: N days before the month's first
 *          game (the club's `monthListOpensDaysBefore`), 10:00 London.
 *          `signupEndsAt`: a day later. From then the month is run by the
 *          weekly flow (slice 5), and the organiser is asked for the price
 *          (slice 4).
 *   WHO    `planCarryOver`: this month's regulars, in slot order.
 *   DOORS  `readSignupMessage`: the fixed words of a typed sign-up, in
 *          English and Turkish ("IN FOR NOVEMBER", "Kasım yokum"), and
 *          the bare words of a reply to the list.
 *          `reconcileSignupPaste`: a pasted list. It NEVER creates a
 *          player, never guesses one, and only ever changes the SENDER'S
 *          own line.
 *   WRITE  `decideSignup`: what one person's choice writes.
 *   LIST   `buildSignupList`, and whether a paste shows it.
 *
 * Nothing here reads a database, calls a model or knows what a club is.
 * A club on "weekly" never reaches any of it.
 */
import { formatLondon, londonDateTimeToUtc } from "./london-time";
import { foldListText, monthOfWord, type MonthlyList, type MonthlyListEntry } from "./monthly-list";
import { candidatesFor, monthFixtureDates, monthStartToDate, nameKey } from "./squad-month-rules";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ── When ───────────────────────────────────────────────────────────────

/** The list is posted at 10:00 London (plan 4.1). */
export const LIST_OPEN_TIME = "10:00";
const DAY_FROM_HOUR = 8;
const QUIET_FROM_HOUR = 22;

/** 08:00 to 21:59 London: the only hours MatchTime posts or DMs in. */
export function isDaytime(now: Date): boolean {
  const hour = Number(formatLondon(now, "H"));
  return hour >= DAY_FROM_HOUR && hour < QUIET_FROM_HOUR;
}

/** "2026-11-01" after "2026-10-01". */
export function nextMonthStart(monthStart: string): string {
  const d = monthStartToDate(monthStart);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

/** "2026-09-01" before "2026-10-01". */
export function previousMonthStart(monthStart: string): string {
  const d = monthStartToDate(monthStart);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

/** The month's games of a weekly fixture, as London kick-offs, in order.
 *  From the CALENDAR, like `monthFixtureDates`. Empty for a bad time. */
export function monthKickoffs(monthStart: string, dayOfWeek: number, time: string): Date[] {
  try {
    return monthFixtureDates(monthStart, dayOfWeek).map((d) => londonDateTimeToUtc(d, time));
  } catch {
    return [];
  }
}

/** The month's first kick-off, or null when the fixture's time cannot be read. */
export function firstKickoffOf(monthStart: string, dayOfWeek: number, time: string): Date | null {
  const first = monthKickoffs(monthStart, dayOfWeek, time)[0];
  return first && !Number.isNaN(first.getTime()) ? first : null;
}

/** N London calendar days before the first game, at 10:00 London. */
export function listOpensAt(firstKickoff: Date, daysBefore: number): Date {
  const day = new Date(`${formatLondon(firstKickoff, "yyyy-MM-dd")}T12:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - daysBefore);
  return londonDateTimeToUtc(day.toISOString().slice(0, 10), LIST_OPEN_TIME);
}

/** Is it time to open the list? From its hour, in waking hours only, and
 *  never once the month's first game has kicked off (a month already
 *  under way is started by the organiser, plan 4.5). */
export function listOpenDue(p: { now: Date; opensAt: Date; firstKickoff: Date }): boolean {
  const t = p.now.getTime();
  return t >= p.opensAt.getTime() && t < p.firstKickoff.getTime() && isDaytime(p.now);
}

/** Names are in two days before the month's first game. */
export const SIGNUP_ENDS_BEFORE_MS = 2 * DAY_MS;

/**
 * When sign-up ends: two days before the month's first game, and never
 * less than two hours after a list that opened late. The list post says
 * so. From this moment the weekly flow runs the month, and the list
 * MatchTime posts is the week's; "IN FOR <MONTH>", a pasted "List for
 * <Month>" and the page still sign a player up for the MONTH until the
 * first game kicks off.
 */
export function signupEndsAt(listOpenedAt: Date, firstKickoff: Date): Date {
  return new Date(Math.max(listOpenedAt.getTime() + 2 * HOUR_MS, firstKickoff.getTime() - SIGNUP_ENDS_BEFORE_MS));
}

// ── Who is carried over (plan 4.1) ─────────────────────────────────────

export interface CarrySource {
  userId: string;
  kind: string;
  tier: string;
  slot: number | null;
  /** Taken off the month (`SquadMonthMember.leftAt`). */
  left: boolean;
  /** Still in the group and active (`Membership.leftAt`, `User.isActive`). */
  here: boolean;
}

export interface CarriedMember {
  userId: string;
  tier: "standard" | "concession";
  /** 1, 2, 3 in this month's slot order. Null when there is no place left. */
  slot: number | null;
  waiting: boolean;
}

/**
 * This month's regulars, on next month's list from the start. Not carried:
 * PAYG players, anyone taken off the month, anyone who has left the group
 * or been deactivated (the rolling squad's own exclusions).
 */
export function planCarryOver(p: { previous: CarrySource[]; maxRegulars: number }): CarriedMember[] {
  const regulars = p.previous
    .filter((m) => m.kind === "regular" && !m.left && m.here)
    .sort((a, b) => (a.slot ?? Number.MAX_SAFE_INTEGER) - (b.slot ?? Number.MAX_SAFE_INTEGER) || a.userId.localeCompare(b.userId));
  return regulars.map((m, i) => {
    const waiting = i >= p.maxRegulars;
    return { userId: m.userId, tier: m.tier === "concession" ? "concession" : "standard", slot: waiting ? null : i + 1, waiting };
  });
}

// ── The words of a sign-up message ─────────────────────────────────────

export type SignupChoice = "in" | "out" | "payg";

export interface SignupAsk {
  choice: SignupChoice;
  /** 1 to 12 when the message names a month. Null: a bare reply to the list. */
  month: number | null;
  /** Days of the month a PAYG player named ("9th and 23rd"). */
  days: number[];
}

const TR_LOCATIVE = /^(.+?)(?:da|de|ta|te)$/;
const DAY_TOKEN = /^(\d{1,2})(?:st|nd|rd|th)?$/;
const DAY_JOINER = new Set(["and", "ve"]);

/** Whole messages only, after the month is `M` and a run of days is `D`.
 *  The FULL form: "for <month>" in English, the month then the word in
 *  Turkish. "Jan payg" and "PAYG November" are not it. */
const WITH_MONTH: Record<SignupChoice, ReadonlySet<string>> = {
  in: new Set(["in for M", "im in for M", "i m in for M", "i am in for M", "count me in for M", "M varim", "M icin varim", "M ayi icin varim"]),
  out: new Set([
    "out for M",
    "im out for M",
    "i m out for M",
    "i am out for M",
    "not in for M",
    "im not in for M",
    "i m not in for M",
    "i am not in for M",
    "M yokum",
    "M icin yokum",
    "M ayi icin yokum",
  ]),
  payg: new Set(["payg for M", "payg for M D", "payg D for M", "M icin payg", "M icin payg D"]),
};

/** A month's short name is not enough to sign anybody up for it. */
const MONTH_ABBREVIATIONS = new Set(["jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"]);

/** The bare words, read only for a reply to the list itself. */
const BARE: Record<SignupChoice, ReadonlySet<string>> = {
  in: new Set(["in", "im in", "i m in", "i am in", "count me in", "yes", "varim", "ben varim", "evet"]),
  out: new Set(["out", "im out", "i m out", "i am out", "not in", "not this month", "no", "yokum", "ben yokum", "bu ay yokum", "hayir"]),
  payg: new Set(["payg", "payg D", "D payg"]),
};

/**
 * Is this message a sign-up for a month, in the fixed vocabulary?
 *
 * The WHOLE message must be one of the phrases, with the month's full
 * name: "IN FOR NOVEMBER", "I'm out for November", "PAYG for November 9th
 * and 23rd", "Kasım varım", "Kasım'da yokum". A sentence that merely mentions the month ("who is in
 * for November?") is not one, and a plain "IN" is this week's game, as it
 * always was (plan 4.1).
 *
 * `quoted`: the message is a reply to the list post, so the bare word
 * ("IN", "varım", "PAYG 9th only") is enough.
 */
export function readSignupMessage(text: string | null | undefined, opts: { quoted: boolean }): SignupAsk | null {
  const tokens = foldListText(text ?? "")
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
  if (tokens.length === 0 || tokens.length > 12) return null;

  const months: number[] = [];
  const days: number[] = [];
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    // "may" is also a word; nothing in this vocabulary uses it as one.
    const month = MONTH_ABBREVIATIONS.has(tok) ? null : (monthOfWord(tok) ?? monthOfWord(TR_LOCATIVE.exec(tok)?.[1] ?? ""));
    if (month !== null) {
      months.push(month);
      out.push("M");
      continue;
    }
    const day = DAY_TOKEN.exec(tok);
    if (day) {
      const n = Number(day[1]);
      if (n < 1 || n > 31) return null;
      days.push(n);
      if (out[out.length - 1] !== "D") out.push("D");
      continue;
    }
    // "9th and 23rd": a joiner between two days is part of the run.
    if (DAY_JOINER.has(tok) && out[out.length - 1] === "D" && DAY_TOKEN.test(tokens[i + 1] ?? "")) continue;
    out.push(tok);
  }
  if (months.length > 1) return null;
  // "only" / "sadece" at the end of a PAYG line adds nothing.
  if (out.length > 1 && (out[out.length - 1] === "only" || out[out.length - 1] === "sadece")) out.pop();
  const phrase = out.join(" ");

  const table = months.length === 1 ? WITH_MONTH : opts.quoted ? BARE : null;
  if (!table) return null;
  for (const choice of ["in", "out", "payg"] as const) {
    if (!table[choice].has(phrase)) continue;
    if (choice !== "payg" && days.length > 0) return null;
    return { choice, month: months[0] ?? null, days: [...new Set(days)] };
  }
  return null;
}

// ── One member of a month in sign-up ───────────────────────────────────

/** `SquadMonthMember.note` of somebody who asked for a regular place when
 *  every place was taken. They are stored as a PAYG player (so the weekly
 *  flow offers them open places and never charges them for the month)
 *  with this note. One constant, shared by the writer and the reader. */
export const WAITING_NOTE = "waiting for a regular place";

export interface SignupMember {
  userId: string;
  name: string;
  kind: "regular" | "payg";
  slot: number | null;
  /** Wants a regular place and there was none (`WAITING_NOTE`). */
  waiting: boolean;
  /** Off the month (`SquadMonthMember.leftAt`): said OUT, or removed. */
  out: boolean;
  paid: "none" | "claimed" | "confirmed";
  paygMatchIds: string[];
}

export interface MonthMatchDay {
  matchId: string;
  /** The London day of the month the match is played on. */
  day: number;
}

export type SignupOutcome = "regular" | "waiting" | "payg" | "out";

export interface SignupRow {
  kind: "regular" | "payg";
  slot: number | null;
  waiting: boolean;
  out: boolean;
  paygMatchIds: string[];
}

export type SignupDecision =
  /** Already so. Nothing is written. */
  | { kind: "none"; outcome: SignupOutcome }
  /** They have said they paid (or it is confirmed): what they owe is not
   *  changed by a message. The organiser changes it. */
  | { kind: "locked"; outcome: SignupOutcome }
  | { kind: "write"; outcome: SignupOutcome; row: SignupRow; unknownDays: number[] };

const outcomeOf = (m: SignupMember): SignupOutcome => (m.out ? "out" : m.waiting ? "waiting" : m.kind === "regular" ? "regular" : "payg");

/**
 * What one person's choice writes to the month.
 *
 *  - IN: a regular, at their old number while it is free, else the lowest
 *    free one. With every place taken they WAIT, and are not a regular;
 *  - PAYG: no number, and the games they named;
 *  - OUT: off the month. The row stays, with whatever it knows of money;
 *  - somebody who says they have paid is not moved by their own message
 *    (`locked`): only `byOrganiser` may, and only an organiser may go past
 *    the cap.
 */
export function decideSignup(p: {
  choice: SignupChoice;
  days: number[];
  existing: SignupMember | null;
  /** Everybody else on the month. */
  others: SignupMember[];
  maxRegulars: number;
  matches: MonthMatchDay[];
  byOrganiser?: boolean;
}): SignupDecision {
  const { existing, choice } = p;
  const now: SignupOutcome | null = existing ? outcomeOf(existing) : null;
  const taken = new Set(p.others.filter((m) => !m.out && m.kind === "regular" && m.slot != null).map((m) => m.slot as number));

  if (choice === "in") {
    if (now === "regular") return { kind: "none", outcome: "regular" };
    const wanted = existing?.slot ?? null;
    let slot: number | null = wanted !== null && !taken.has(wanted) && (p.byOrganiser || wanted <= p.maxRegulars) ? wanted : null;
    if (slot === null) {
      for (let n = 1; p.byOrganiser || n <= p.maxRegulars; n++) {
        if (!taken.has(n)) {
          slot = n;
          break;
        }
      }
    }
    if (slot === null) {
      if (now === "waiting") return { kind: "none", outcome: "waiting" };
      // Still pay-as-you-go while they wait, on any dates they had named.
      const paygMatchIds = existing && !existing.out && existing.kind === "payg" ? existing.paygMatchIds : [];
      return { kind: "write", outcome: "waiting", row: { kind: "payg", slot: null, waiting: true, out: false, paygMatchIds }, unknownDays: [] };
    }
    return { kind: "write", outcome: "regular", row: { kind: "regular", slot, waiting: false, out: false, paygMatchIds: [] }, unknownDays: [] };
  }

  const locked = existing !== null && !existing.out && existing.paid !== "none" && !p.byOrganiser;

  if (choice === "out") {
    if (!existing || existing.out) return { kind: "none", outcome: "out" };
    if (locked) return { kind: "locked", outcome: outcomeOf(existing) };
    return {
      kind: "write",
      outcome: "out",
      row: { kind: existing.kind, slot: existing.slot, waiting: existing.waiting, out: true, paygMatchIds: existing.paygMatchIds },
      unknownDays: [],
    };
  }

  // PAYG, with or without dates.
  if (locked && existing) return { kind: "locked", outcome: outcomeOf(existing) };
  const days = [...new Set(p.days)];
  const paygMatchIds = p.matches.filter((m) => days.includes(m.day)).map((m) => m.matchId);
  const unknownDays = days.filter((d) => !p.matches.some((m) => m.day === d));
  if (
    now === "payg" &&
    existing &&
    existing.paygMatchIds.length === paygMatchIds.length &&
    paygMatchIds.every((id) => existing.paygMatchIds.includes(id)) &&
    unknownDays.length === 0
  ) {
    return { kind: "none", outcome: "payg" };
  }
  return { kind: "write", outcome: "payg", row: { kind: "payg", slot: null, waiting: false, out: false, paygMatchIds }, unknownDays };
}

// ── A pasted sign-up list (plan 6.2, slice 5's rules) ──────────────────

export interface SignupRosterMember {
  userId: string;
  name: string | null;
  aliases?: string[];
}

export interface SignupNotAdded {
  name: string;
  /** unknown: no player of this club has that name or alias.
   *  ambiguous: it fits more than one player.
   *  not-the-sender: a club player written in by somebody else. Only the
   *  player themselves joins a month. */
  reason: "unknown" | "ambiguous" | "not-the-sender";
}

export interface SignupPaidClaim {
  userId: string;
  name: string;
  self: boolean;
  amountPence: number | null;
}

/** With no month header, this share of a list's names must already be on
 *  the month for it to be read as its list (slice 5's rule and number). */
export const MIN_SIGNUP_OVERLAP = 0.6;

type Resolved = { kind: "one"; userId: string } | { kind: "none" } | { kind: "ambiguous" };

/** Whole name, a known alias, then the leading name. Never fuzzy. Two
 *  candidates are narrowed to the ones already on the month. */
function makeResolver(roster: SignupRosterMember[], known: ReadonlySet<string>): (name: string) => Resolved {
  const keyed = roster.map((m) => ({ userId: m.userId, key: nameKey(m.name), aliasKeys: (m.aliases ?? []).map(nameKey) }));
  return (name) => {
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
 * Compare a pasted list with a month in sign-up, BY NAME. Nothing is
 * written here.
 *
 *  - IS IT THIS MONTH'S LIST? With the month's header; or, with none, when
 *    60% of its names are already on the month (and never when
 *    `needHeader`: a week's list is live for this club, and a headerless
 *    list is that one).
 *  - THE SENDER'S OWN LINE is the only one a paste changes: their name in
 *    a numbered line is IN (PAYG when marked, with its dates). A paste
 *    never takes anybody OFF the month, the sender included.
 *  - NOBODY ELSE is added, taken off or created. A club player written in
 *    by somebody else, a name nobody has and a name two players have are
 *    reported (`notAdded`). A name missing from the paste changes nothing:
 *    every old copy would otherwise undo the sign-ups since.
 *  - A NEW "(paid)" MARK on a regular's line is a claim, whoever wrote it
 *    (D3). Slice 4 records it; it is never a confirmation.
 */
export function reconcileSignupPaste(args: {
  list: MonthlyList;
  /** Everybody on the month, those who said OUT included. */
  members: SignupMember[];
  roster: SignupRosterMember[];
  /** 1 to 12. */
  monthNumber: number;
  senderUserId: string | null;
  senderNames?: Array<string | null | undefined>;
  needHeader?: boolean;
}): { thisList: boolean; self: { choice: SignupChoice; days: number[] } | null; notAdded: SignupNotAdded[]; paidClaims: SignupPaidClaim[] } {
  const { list, senderUserId } = args;
  const nothing = { self: null, notAdded: [], paidClaims: [] };
  if (list.month ? list.month.month !== args.monthNumber : args.needHeader === true) return { thisList: false, ...nothing };

  const active = args.members.filter((m) => !m.out);
  const memberOf = new Map(active.map((m) => [m.userId, m]));
  const resolve = makeResolver(args.roster, new Set(memberOf.keys()));
  const named = (entries: MonthlyListEntry[]) => entries.filter((e) => e.name).map((e) => ({ e, r: resolve(e.name) }));
  const lines = named(list.slots);
  const elsewhere = [...named(list.sections.cantPlay), ...named(list.sections.reserves), ...named(list.sections.other)];

  if (!list.month) {
    const ours = lines.filter((x) => x.r.kind === "one" && memberOf.has(x.r.userId)).length;
    if (lines.length === 0 || ours / lines.length < MIN_SIGNUP_OVERLAP) return { thisList: false, ...nothing };
  }

  const onPaste = new Set<string>();
  for (const { r } of [...lines, ...elsewhere]) if (r.kind === "one") onPaste.add(r.userId);

  // The sender writing themselves in under a name we do not have ("Big
  // Dan"): slice 5's narrow rule. They are a club player, are not on the
  // paste under a name we know, the paste has exactly ONE line that
  // matches nobody, and that line carries their first name as a whole
  // word, or is their whole name.
  const senderKeys = (args.senderNames ?? []).map((n) => nameKey(n)).filter(Boolean);
  const firstNames = new Set(senderKeys.map((k) => k.split(" ")[0]).filter((w) => w.length >= 2));
  const unknown = lines.filter((x) => x.r.kind === "none");
  const selfLine =
    senderUserId &&
    args.roster.some((m) => m.userId === senderUserId) &&
    !onPaste.has(senderUserId) &&
    unknown.length === 1 &&
    (senderKeys.includes(nameKey(unknown[0].e.name)) ||
      nameKey(unknown[0].e.name)
        .split(" ")
        .some((w) => firstNames.has(w)))
      ? unknown[0].e
      : null;

  let self: { choice: SignupChoice; days: number[] } | null = null;
  const notAdded: SignupNotAdded[] = [];
  const paidClaims: SignupPaidClaim[] = [];
  const seen = new Set<string>();
  const selfFrom = (e: MonthlyListEntry): void => {
    const want: SignupChoice = e.marks.payg ? "payg" : "in";
    const mine = senderUserId ? memberOf.get(senderUserId) : undefined;
    const days = e.marks.paygDates.filter((d) => d.month === null || d.month === args.monthNumber).map((d) => d.day);
    // Already so: a regular restating their line, a PAYG player theirs.
    if (mine && !mine.waiting && ((want === "in" && mine.kind === "regular") || (want === "payg" && mine.kind === "payg" && days.length === 0))) return;
    self = { choice: want, days: want === "payg" ? [...new Set(days)] : [] };
  };

  for (const { e, r } of lines) {
    if (r.kind !== "one") {
      if (e === selfLine) selfFrom(e);
      else notAdded.push({ name: e.name, reason: r.kind === "none" ? "unknown" : "ambiguous" });
      continue;
    }
    if (seen.has(r.userId)) continue;
    seen.add(r.userId);
    const isSelf = r.userId === senderUserId;
    const m = memberOf.get(r.userId);
    if (isSelf) selfFrom(e);
    else if (!m) notAdded.push({ name: e.name, reason: "not-the-sender" });
    if (e.marks.paid && !e.marks.payg && m?.kind === "regular" && !m.waiting && m.paid === "none") {
      paidClaims.push({ userId: r.userId, name: e.name, self: isSelf, amountPence: e.marks.paidAmountPence });
    }
  }

  // A copy with the sender's own number blank, and their name nowhere on
  // it, takes NOBODY off: it may be an old copy, or one somebody else
  // edited. Only "OUT FOR <MONTH>" or the page takes a player off a month.
  return { thisList: true, self, notAdded, paidClaims };
}

// ── The list ───────────────────────────────────────────────────────────

export interface SignupList {
  /** 1 to the cap (further when an organiser went past it), blanks kept. */
  slots: Array<{ slot: number; userId: string | null; name: string; paid: boolean }>;
  /** PAYG players, numbered on after the regular places. */
  payg: Array<{ slot: number; userId: string; name: string; days: number[] }>;
  waiting: Array<{ userId: string; name: string }>;
  /** How many regulars are on it. */
  regulars: number;
}

/** The month's list as it stands. Somebody who said OUT is not on it. */
export function buildSignupList(p: { members: SignupMember[]; maxRegulars: number; matches: MonthMatchDay[] }): SignupList {
  const active = p.members.filter((m) => !m.out);
  const regulars = active.filter((m) => m.kind === "regular");
  // A regular whose number is missing or already held (somebody who left
  // the group and came back to find it taken) is shown at the lowest free
  // number: nobody on the month is ever missing from its list.
  const bySlot = new Map<number, SignupMember>();
  const unplaced: SignupMember[] = [];
  for (const m of regulars) {
    if (m.slot != null && !bySlot.has(m.slot)) bySlot.set(m.slot, m);
    else unplaced.push(m);
  }
  for (const m of unplaced) {
    let n = 1;
    while (bySlot.has(n)) n++;
    bySlot.set(n, m);
  }
  const last = Math.max(p.maxRegulars, ...bySlot.keys());
  const slots: SignupList["slots"] = [];
  for (let n = 1; n <= last; n++) {
    const m = bySlot.get(n);
    slots.push({ slot: n, userId: m?.userId ?? null, name: m?.name ?? "", paid: m ? m.paid !== "none" : false });
  }
  const dayOf = new Map(p.matches.map((m) => [m.matchId, m.day]));
  const byName = (a: SignupMember, b: SignupMember) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId);
  const payg = active
    .filter((m) => m.kind === "payg" && !m.waiting)
    .sort(byName)
    .map((m, i) => ({
      slot: last + 1 + i,
      userId: m.userId,
      name: m.name,
      days: m.paygMatchIds
        .map((id) => dayOf.get(id))
        .filter((d): d is number => d !== undefined)
        .sort((a, b) => a - b),
    }));
  const waiting = active
    .filter((m) => m.waiting)
    .sort(byName)
    .map((m) => ({ userId: m.userId, name: m.name }));
  return { slots, payg, waiting, regulars: regulars.length };
}

/**
 * Does this paste show the list as MatchTime has it? Then the group has
 * just seen it, and MatchTime does not post it straight back. Compared by
 * who is a regular in which place and who is PAYG; paid marks and PAYG
 * dates are not compared.
 */
export function signupPasteShowsSameList(args: { list: MonthlyList; ours: SignupList; roster: SignupRosterMember[] }): boolean {
  const { list, ours } = args;
  const known = new Set<string>([
    ...ours.slots.map((s) => s.userId).filter((u): u is string => u !== null),
    ...ours.payg.map((p) => p.userId),
    ...ours.waiting.map((w) => w.userId),
  ]);
  const resolve = makeResolver(args.roster, known);
  const who = (e: MonthlyListEntry): string => {
    const r = resolve(e.name);
    return r.kind === "one" ? r.userId : `?${nameKey(e.name)}`;
  };
  const pastedRegulars = new Map<number, string>();
  const pastedPayg = new Set<string>();
  for (const e of list.slots) {
    if (!e.name) continue;
    if (e.marks.payg) {
      pastedPayg.add(who(e));
      continue;
    }
    if (e.slot == null || pastedRegulars.has(e.slot)) return false;
    pastedRegulars.set(e.slot, who(e));
  }
  const oursRegulars = ours.slots.filter((s) => s.userId);
  if (pastedRegulars.size !== oursRegulars.length) return false;
  for (const s of oursRegulars) if (pastedRegulars.get(s.slot) !== s.userId) return false;
  if (pastedPayg.size !== ours.payg.length) return false;
  for (const p of ours.payg) if (!pastedPayg.has(p.userId)) return false;
  return true;
}

// ── When the sign-up list is posted ────────────────────────────────────

/** At most one list post every 30 minutes (slice 5's floor). */
export const SIGNUP_REPOST_FLOOR_MS = 30 * 60 * 1000;

/**
 * Is a sign-up list post due? Only while sign-up is open, in waking hours,
 * never within 30 minutes of the last list post, and only when the list
 * differs from the one the group last saw (a post of ours, or a member's
 * paste that showed the same list). The first post is simply the first
 * difference: the group has seen none.
 */
export function decideSignupListPost(p: {
  now: Date;
  /** Sign-up is open (the month's status), and when it ends. */
  open: boolean;
  endsAt: Date;
  hash: string;
  lastShownHash: string | null;
  lastPostAt: Date | null;
}): boolean {
  if (!p.open || p.now.getTime() >= p.endsAt.getTime() || !isDaytime(p.now)) return false;
  if (p.lastPostAt && p.now.getTime() - p.lastPostAt.getTime() < SIGNUP_REPOST_FLOOR_MS) return false;
  return p.hash !== p.lastShownHash;
}

// ── The month's games, and whether it has started ──────────────────────

/**
 * The month's games, as kick-offs in order: THE FIXTURE'S CALENDAR for
 * the month, minus the weeks whose match exists and is cancelled.
 *
 * Never "the Match rows that exist": only a month MatchTime opened itself
 * has a row for every game. A month an organiser started part-way through
 * (plan 4.5) has a row for the next game alone, and a club new to
 * MatchTime has none for the games it played before it joined. Counting
 * rows would charge a regular added to such a month for one game.
 *
 * A calendar day whose match exists and is live is that match's own
 * kick-off (a format may play at its own time).
 */
export function monthGames(p: { calendar: Date[]; matches: Array<{ date: Date; cancelled: boolean }> }): Date[] {
  const day = (d: Date) => formatLondon(d, "yyyy-MM-dd");
  const out: Date[] = [];
  for (const kickoff of p.calendar) {
    const onDay = p.matches.filter((m) => day(m.date) === day(kickoff));
    const live = onDay.find((m) => !m.cancelled);
    if (live) out.push(live.date);
    else if (onDay.length === 0) out.push(kickoff);
    // Otherwise every match of that day is cancelled: not a game.
  }
  return out;
}

/**
 * Has the month started? Its first game has kicked off, OR an organiser
 * started it part-way through. A month that has started is never joined
 * through a sign-up door, and a pasted "List for <Month>" in it is the
 * WEEK's list: only the organiser changes who is on the month.
 */
export function monthStarted(p: { firstKickoff: Date; startedMidMonthAt: Date | null; now: Date }): boolean {
  return p.startedMidMonthAt !== null || p.now.getTime() >= p.firstKickoff.getTime();
}
