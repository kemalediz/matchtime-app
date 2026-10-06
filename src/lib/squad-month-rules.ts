/**
 * Monthly squad: the pure rules (slice 2, 2026-10-05).
 * Plan: MDs/monthly-squad-plan-2026-10-05.md, sections 3 and 4.5.
 *
 * A per-club mode, OFF by default (`Organisation.squadMode = "weekly"`,
 * which is every club today, Sutton FC included). Regulars commit and pay
 * for the month; PAYG players fill the gaps.
 *
 * This file holds everything that needs no database: the settings'
 * vocabulary and validation, the month's calendar, and the plan for
 * STARTING A MONTH PART-WAY THROUGH from the organiser's own list (who
 * the regulars are, who has paid and how much, the PAYG players, the
 * credits carried in). It is client-safe: the settings section and the
 * month page import it. The writes are in `squad-month.ts`.
 *
 * Nothing here posts to WhatsApp and nothing calls a model.
 */
import { formatLondon, londonDateTimeToUtc } from "./london-time";
import { normaliseName } from "./name-normalise";

// ── Settings ───────────────────────────────────────────────────────────

export const SQUAD_MODES = ["weekly", "monthly"] as const;
export type SquadMode = (typeof SQUAD_MODES)[number];

/** Anything that is not exactly "monthly" is today's weekly behaviour. */
export function normaliseSquadMode(v: unknown): SquadMode {
  return v === "monthly" ? "monthly" : "weekly";
}

export const MONTH_CREDIT_RULES = ["any-miss", "filled-only", "none"] as const;
export type MonthCreditRule = (typeof MONTH_CREDIT_RULES)[number];

export function normaliseCreditRule(v: unknown): MonthCreditRule {
  return (MONTH_CREDIT_RULES as readonly unknown[]).includes(v) ? (v as MonthCreditRule) : "any-miss";
}

/** £100 a game: a typo guard, not a price list. Mirrors the CHECK constraint. */
export const MAX_PER_GAME_PENCE = 10_000;
export const LIST_OPENS_DAYS_MIN = 1;
export const LIST_OPENS_DAYS_MAX = 28;
export const LIST_OPENS_DAYS_DEFAULT = 7;
export const PAYMENT_INSTRUCTIONS_MAX = 500;

export interface MonthlySquadPatch {
  squadMode?: SquadMode;
  /** Pence. null clears it. */
  paygPricePence?: number | null;
  monthListOpensDaysBefore?: number;
  monthCreditRule?: MonthCreditRule;
  /** Free text. null or blank clears it. */
  paymentInstructions?: string | null;
}

export type MonthlySquadSettingError = "bad-mode" | "bad-price" | "bad-days" | "bad-rule" | "too-long" | "empty";

/** The columns a valid patch writes. */
export interface MonthlySquadData {
  squadMode?: SquadMode;
  /** Written only by a switch TO monthly: the month replaces the rolling squad. */
  rollingSquadEnabled?: false;
  paygPricePence?: number | null;
  monthListOpensDaysBefore?: number;
  monthCreditRule?: MonthCreditRule;
  paymentInstructions?: string | null;
}

const PATCH_KEYS = ["squadMode", "paygPricePence", "monthListOpensDaysBefore", "monthCreditRule", "paymentInstructions"] as const;

const isWholeNumber = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * Validate a settings patch. One bad key refuses the whole patch, so
 * nothing is ever half saved, and a patch with nothing in it is refused
 * rather than silently ignored.
 */
export function prepareMonthlySquadPatch(
  patch: MonthlySquadPatch | null | undefined,
): { ok: true; data: MonthlySquadData; keys: string[] } | { ok: false; error: MonthlySquadSettingError } {
  const p = (patch ?? {}) as Record<string, unknown>;
  const keys = PATCH_KEYS.filter((k) => k in p);
  if (keys.length === 0) return { ok: false, error: "empty" };
  const data: MonthlySquadData = {};

  if ("squadMode" in p) {
    if (p.squadMode !== "weekly" && p.squadMode !== "monthly") return { ok: false, error: "bad-mode" };
    data.squadMode = p.squadMode;
    if (p.squadMode === "monthly") data.rollingSquadEnabled = false;
  }
  if ("paygPricePence" in p) {
    const v = p.paygPricePence;
    if (v !== null && !(isWholeNumber(v) && v >= 1 && v <= MAX_PER_GAME_PENCE)) return { ok: false, error: "bad-price" };
    data.paygPricePence = v as number | null;
  }
  if ("monthListOpensDaysBefore" in p) {
    const v = p.monthListOpensDaysBefore;
    if (!(isWholeNumber(v) && v >= LIST_OPENS_DAYS_MIN && v <= LIST_OPENS_DAYS_MAX)) return { ok: false, error: "bad-days" };
    data.monthListOpensDaysBefore = v;
  }
  if ("monthCreditRule" in p) {
    if (!(MONTH_CREDIT_RULES as readonly unknown[]).includes(p.monthCreditRule)) return { ok: false, error: "bad-rule" };
    data.monthCreditRule = p.monthCreditRule as MonthCreditRule;
  }
  if ("paymentInstructions" in p) {
    const v = p.paymentInstructions;
    if (v !== null && typeof v !== "string") return { ok: false, error: "too-long" };
    // The club's own words. Control characters out, line breaks kept.
    const text = (v ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();
    if (text.length > PAYMENT_INSTRUCTIONS_MAX) return { ok: false, error: "too-long" };
    data.paymentInstructions = text === "" ? null : text;
  }
  return { ok: true, data, keys: [...keys] };
}

/** "7.50", "£8", "30" to pence. null for anything that is not plainly an amount. */
export function parsePounds(text: string | null | undefined): number | null {
  const m = /^£?\s*(\d{1,4})(?:\.(\d{1,2}))?$/.exec((text ?? "").trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

/** 750 to "7.50", for a form field. */
export function poundsText(pence: number | null | undefined): string {
  return pence == null ? "" : (pence / 100).toFixed(2);
}

// ── The month's calendar ───────────────────────────────────────────────

/** The London calendar month a moment falls in, as its 1st: "2026-10-01". */
export function londonMonthStart(now: Date): string {
  return `${formatLondon(now, "yyyy-MM")}-01`;
}

/** The DATE column value for a month start ("2026-10-01" reads back as UTC midnight). */
export function monthStartToDate(monthStart: string): Date {
  if (!/^\d{4}-\d{2}-01$/.test(monthStart)) throw new Error(`Bad month start "${monthStart}": expected YYYY-MM-01`);
  return new Date(`${monthStart}T00:00:00.000Z`);
}

/**
 * Every date in the month that falls on the fixture's weekday
 * (0 = Sunday .. 6 = Saturday), as "YYYY-MM-DD". October 2026 has four
 * Mondays, November 2026 five.
 *
 * This is the CALENDAR, not the Match table: a club that starts on
 * MatchTime part-way through a month has no Match row for the games it
 * played before it joined, and those games still count.
 */
export function monthFixtureDates(monthStart: string, dayOfWeek: number): string[] {
  const first = monthStartToDate(monthStart);
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) throw new Error(`Bad weekday ${dayOfWeek}`);
  const out: string[] = [];
  for (let d = new Date(first); d.getUTCMonth() === first.getUTCMonth(); d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === dayOfWeek) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * How many of these dates' London kick-offs have passed. A fixture whose
 * time cannot be read counts none: this only pre-fills a field the
 * organiser can correct, so it must never break the page.
 */
export function gamesPlayedBy(dates: string[], time: string, now: Date): number {
  try {
    return dates.filter((d) => londonDateTimeToUtc(d, time).getTime() < now.getTime()).length;
  } catch {
    return 0;
  }
}

/** share x (games covered - credits applied). null while no share is set; never negative. */
export function amountDuePence(p: { sharePence: number | null | undefined; gamesCovered: number; creditsApplied: number }): number | null {
  if (p.sharePence == null) return null;
  return p.sharePence * Math.max(0, p.gamesCovered - p.creditsApplied);
}

// ── Starting a month part-way through (plan 4.5) ───────────────────────

export const MEMBER_KINDS = ["regular", "payg"] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];
export const MEMBER_TIERS = ["standard", "concession"] as const;
export type MemberTier = (typeof MEMBER_TIERS)[number];
/** "claimed" is "says paid" (D3). Only "confirmed" ever sets `paidAt`. */
export const SEED_PAID_STATES = ["none", "claimed", "confirmed"] as const;
export type SeedPaid = (typeof SEED_PAID_STATES)[number];
export type SeedSource = "seed-list" | "seed-tick";

/** A weekly fixture has at most five games in a month; ten leaves room for twice a week. */
export const MAX_GAMES_IN_MONTH = 10;
export const MAX_PAID_PENCE = 100_000;

export interface SeedRowInput {
  userId: string;
  kind: MemberKind;
  tier?: MemberTier;
  /** The list number as written. Omitted: the lowest free number. */
  slot?: number | null;
  paid?: SeedPaid;
  paidAmountPence?: number | null;
  /** Games of credit this regular came into the month with (already taken off what they paid). */
  creditsCarriedIn?: number;
}

export interface MonthSeedInput {
  activityId: string;
  /** The month's games, the ones already played included. */
  gamesScheduled: number;
  /** Games already played when the month is started here. */
  gamesPlayed: number;
  sharePerGamePence?: number | null;
  concessionPerGamePence?: number | null;
  /** Where the rows came from: a pasted list, or ticks on the page. */
  source: SeedSource;
  rows: SeedRowInput[];
}

export type MonthSeedError =
  | "no-players"
  | "bad-fixture"
  | "bad-games"
  | "bad-share"
  | "bad-row"
  | "bad-credits"
  | "bad-amount"
  | "duplicate-player"
  | "duplicate-slot"
  | "not-a-member";

export interface PlannedMonth {
  activityId: string;
  status: "running";
  gamesScheduled: number;
  gamesPlayedBeforeStart: number;
  sharePerGamePence: number | null;
  concessionPerGamePence: number | null;
  startedMidMonthAt: Date;
  startedByUserId: string;
}

export interface PlannedMember {
  userId: string;
  kind: MemberKind;
  tier: MemberTier;
  slot: number;
  gamesCovered: number;
  creditsApplied: number;
  amountDuePence: number | null;
  paidClaimedAt: Date | null;
  paidClaimSource: "list" | "organiser" | null;
  paidClaimedAmountPence: number | null;
  paidAt: Date | null;
  paidAmountPence: number | null;
  paidConfirmedByUserId: string | null;
  source: SeedSource;
}

export interface PlannedCredit {
  userId: string;
  games: 1;
  reason: "carried-in";
  appliedAt: Date;
  createdById: string;
}

const validShare = (v: unknown): v is number | null | undefined =>
  v == null || (isWholeNumber(v) && v >= 1 && v <= MAX_PER_GAME_PENCE);

/**
 * Turn the organiser's account of a month already under way into the rows
 * to write. Pure: the caller supplies who is in the club, who is asking
 * and the time.
 *
 * The rules (plan 4.5):
 *  - the month is "running" at once. Sign-up and pricing happened outside
 *    MatchTime; nothing is posted;
 *  - a regular covers the WHOLE month. The games already played count as
 *    played for them: no credit, no absence;
 *  - "says paid" is a claim and never sets `paidAt`. Only "confirmed", the
 *    organiser's own word on the page, does;
 *  - credits carried in were already taken off what the regular paid, so
 *    they are applied to this month and written to the ledger as used;
 *  - a PAYG player owes nothing for the month: they pay game by game.
 */
export function planMonthSeed(
  input: MonthSeedInput,
  ctx: { memberUserIds: ReadonlySet<string>; actorUserId: string; now: Date },
):
  | { ok: true; month: PlannedMonth; members: PlannedMember[]; credits: PlannedCredit[] }
  | { ok: false; error: MonthSeedError; userId?: string } {
  if (typeof input?.activityId !== "string" || input.activityId === "") return { ok: false, error: "bad-fixture" };
  const { gamesScheduled, gamesPlayed } = input;
  if (!isWholeNumber(gamesScheduled) || gamesScheduled < 1 || gamesScheduled > MAX_GAMES_IN_MONTH) return { ok: false, error: "bad-games" };
  if (!isWholeNumber(gamesPlayed) || gamesPlayed < 0 || gamesPlayed > gamesScheduled) return { ok: false, error: "bad-games" };
  if (!validShare(input.sharePerGamePence) || !validShare(input.concessionPerGamePence)) return { ok: false, error: "bad-share" };
  const share = input.sharePerGamePence ?? null;
  const concession = input.concessionPerGamePence ?? null;
  const rows = Array.isArray(input.rows) ? input.rows : [];
  if (rows.length === 0) return { ok: false, error: "no-players" };

  const seen = new Set<string>();
  const taken = new Set<number>();
  for (const r of rows) {
    const userId = r?.userId;
    if (typeof userId !== "string" || userId === "") return { ok: false, error: "bad-row" };
    if (!(MEMBER_KINDS as readonly unknown[]).includes(r.kind)) return { ok: false, error: "bad-row", userId };
    if (r.tier !== undefined && !(MEMBER_TIERS as readonly unknown[]).includes(r.tier)) return { ok: false, error: "bad-row", userId };
    if (r.paid !== undefined && !(SEED_PAID_STATES as readonly unknown[]).includes(r.paid)) return { ok: false, error: "bad-row", userId };
    if (r.slot != null && !(isWholeNumber(r.slot) && r.slot >= 1 && r.slot <= 99)) return { ok: false, error: "bad-row", userId };
    if (seen.has(userId)) return { ok: false, error: "duplicate-player", userId };
    seen.add(userId);
    if (!ctx.memberUserIds.has(userId)) return { ok: false, error: "not-a-member", userId };
    if (r.slot != null) {
      if (taken.has(r.slot)) return { ok: false, error: "duplicate-slot", userId };
      taken.add(r.slot);
    }
    if (r.kind === "regular") {
      const credits = r.creditsCarriedIn ?? 0;
      if (!isWholeNumber(credits) || credits < 0 || credits > gamesScheduled) return { ok: false, error: "bad-credits", userId };
      const amount = r.paidAmountPence;
      if (amount != null && !(isWholeNumber(amount) && amount >= 0 && amount <= MAX_PAID_PENCE)) return { ok: false, error: "bad-amount", userId };
    }
  }

  // Regulars first, then PAYG players, each in the order given. A number
  // written on the list is kept; everyone else takes the lowest free one.
  const ordered = [...rows.filter((r) => r.kind === "regular"), ...rows.filter((r) => r.kind === "payg")];
  let next = 1;
  const freeSlot = (): number => {
    while (taken.has(next)) next++;
    taken.add(next);
    return next;
  };

  const members: PlannedMember[] = [];
  const credits: PlannedCredit[] = [];
  for (const r of ordered) {
    const slot = r.slot ?? freeSlot();
    const base = { userId: r.userId, kind: r.kind, slot, source: input.source };
    const unpaid = {
      paidClaimedAt: null,
      paidClaimSource: null,
      paidClaimedAmountPence: null,
      paidAt: null,
      paidAmountPence: null,
      paidConfirmedByUserId: null,
    };
    if (r.kind === "payg") {
      members.push({ ...base, tier: "standard", gamesCovered: 0, creditsApplied: 0, amountDuePence: null, ...unpaid });
      continue;
    }
    const tier = r.tier ?? "standard";
    const creditsApplied = r.creditsCarriedIn ?? 0;
    const due = amountDuePence({ sharePence: tier === "concession" ? concession : share, gamesCovered: gamesScheduled, creditsApplied });
    const paid = r.paid ?? "none";
    const amount = r.paidAmountPence ?? null;
    members.push({
      ...base,
      tier,
      gamesCovered: gamesScheduled,
      creditsApplied,
      amountDuePence: due,
      ...unpaid,
      ...(paid === "claimed"
        ? {
            paidClaimedAt: ctx.now,
            paidClaimSource: input.source === "seed-list" ? ("list" as const) : ("organiser" as const),
            paidClaimedAmountPence: amount,
          }
        : {}),
      ...(paid === "confirmed" ? { paidAt: ctx.now, paidAmountPence: amount ?? due, paidConfirmedByUserId: ctx.actorUserId } : {}),
    });
    for (let i = 0; i < creditsApplied; i++) {
      credits.push({ userId: r.userId, games: 1, reason: "carried-in", appliedAt: ctx.now, createdById: ctx.actorUserId });
    }
  }

  return {
    ok: true,
    month: {
      activityId: input.activityId,
      status: "running",
      gamesScheduled,
      gamesPlayedBeforeStart: gamesPlayed,
      sharePerGamePence: share,
      concessionPerGamePence: concession,
      startedMidMonthAt: ctx.now,
      startedByUserId: ctx.actorUserId,
    },
    members,
    credits,
  };
}

// ── From a pasted list to a draft (the slice 1 reader's output) ────────

/**
 * What the slice 1 reader (`parseMonthlyList`, plan 6.1) returns, as far
 * as the seed needs it. Declared here structurally, with everything but
 * the name optional, so the reader's own result is assignable to it and
 * this file never imports the reader.
 */
export interface SeedListEntry {
  slot?: number | null;
  name: string;
  marks?: {
    paid?: boolean;
    paidAmountPence?: number | null;
    tier?: string | null;
    payg?: boolean;
    paygDates?: unknown[];
  };
}

export interface SeedListInput {
  month?: { month: number; year?: number | null } | null;
  slots: SeedListEntry[];
  sections?: { cantPlay?: SeedListEntry[]; reserves?: SeedListEntry[] };
}

export interface SeedRosterMember {
  userId: string;
  name: string | null;
  aliases?: string[];
}

export interface SeedDraftRow extends SeedRowInput {
  name: string;
  tier: MemberTier;
  slot: number | null;
  paid: SeedPaid;
  paidAmountPence: number | null;
}

export interface SeedDraftUnmatched {
  slot: number | null;
  name: string;
  kind: MemberKind;
  reason: "unknown" | "ambiguous";
  candidates: string[];
}

/** A name folded for matching: `normaliseName`, then emoji and punctuation out. */
export function nameKey(s: string | null | undefined): string {
  return normaliseName(s ?? "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function candidatesFor(key: string, roster: Array<{ userId: string; key: string; aliasKeys: string[] }>): string[] {
  const exact = roster.filter((m) => m.key === key);
  if (exact.length > 0) return exact.map((m) => m.userId);
  const alias = roster.filter((m) => m.aliasKeys.includes(key));
  if (alias.length > 0) return alias.map((m) => m.userId);
  return roster.filter((m) => m.key.startsWith(`${key} `)).map((m) => m.userId);
}

/**
 * A parsed list becomes a draft for the organiser to check before
 * anything is written. Names are matched against the club's players:
 * the whole name, then a known alias, then the leading name ("Alex" for
 * "Alex Carter"). A name that fits nobody, or more than one player, is
 * handed back unmatched; MatchTime never guesses between two Omars.
 *
 *  - A paid mark is only ever "says paid".
 *  - "Paid but can't play" names are paid regulars who are out this week:
 *    regulars of the month, with no slot of their own on this list.
 *  - Reserves are not members of the month.
 *  - Blank slots are skipped, and nobody is drafted twice.
 *
 * `parseMonthlyList`'s result (`monthly-list.ts`) is passed in as it is.
 */
export function draftSeedFromList(
  list: SeedListInput,
  roster: SeedRosterMember[],
  current: { month: number },
): { rows: SeedDraftRow[]; unmatched: SeedDraftUnmatched[]; monthMismatch: boolean } {
  const keyed = roster.map((m) => ({ userId: m.userId, key: nameKey(m.name), aliasKeys: (m.aliases ?? []).map(nameKey) }));
  const nameOf = new Map(roster.map((m) => [m.userId, m.name ?? ""]));
  const rows: SeedDraftRow[] = [];
  const unmatched: SeedDraftUnmatched[] = [];
  const drafted = new Set<string>();
  const slots = new Set<number>();

  const take = (e: SeedListEntry, where: "slots" | "cantPlay") => {
    const key = nameKey(e?.name);
    if (key === "") return;
    const kind: MemberKind = e.marks?.payg && where === "slots" ? "payg" : "regular";
    const written = where === "slots" && typeof e.slot === "number" ? e.slot : null;
    const found = candidatesFor(key, keyed);
    if (found.length !== 1) {
      unmatched.push({ slot: written, name: e.name.trim(), kind, reason: found.length === 0 ? "unknown" : "ambiguous", candidates: found });
      return;
    }
    const userId = found[0];
    if (drafted.has(userId)) return;
    drafted.add(userId);
    // A number written twice is kept for the first line only.
    const slot = written !== null && !slots.has(written) ? written : null;
    if (slot !== null) slots.add(slot);
    const saysPaid = kind === "regular" && (e.marks?.paid === true || where === "cantPlay");
    rows.push({
      userId,
      name: nameOf.get(userId) ?? "",
      kind,
      tier: kind === "regular" && e.marks?.tier === "concession" ? "concession" : "standard",
      slot,
      paid: saysPaid ? "claimed" : "none",
      paidAmountPence: saysPaid ? (e.marks?.paidAmountPence ?? null) : null,
    });
  };

  for (const e of list?.slots ?? []) take(e, "slots");
  for (const e of list?.sections?.cantPlay ?? []) take(e, "cantPlay");

  return { rows, unmatched, monthMismatch: list?.month != null && list.month.month !== current.month };
}
