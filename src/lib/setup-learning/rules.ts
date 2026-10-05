/**
 * F3, LEARNED SETUP: THE PURE RULES (2026-10-05).
 *
 * MDs/findings.md F3 (Kemal, 2026-10-01: "settings can be automatically
 * done, and shown to the organiser"). Everything here is a decision on
 * facts already loaded: no database, no clock, no model. `run.ts` loads
 * the club and the chat, makes the one model call and writes the result.
 *
 * THE RULES, IN ORDER
 *   1. Nothing is read when the chat is empty or too short
 *      (`historyGate`): fewer than MIN_MESSAGES messages or fewer than
 *      MIN_AUTHORS people. No model call, no change, no DM.
 *   2. The model's answer is parsed defensively (`parseDetection`). Every
 *      evidence quote is checked against the chat, character for
 *      character after normalising spaces and case; a quote that is not in
 *      the chat is dropped (so is a summary the model wrote itself), and
 *      an answer left with no quote counts as not shown. Quotes with long
 *      digit runs (account numbers) are dropped. Each quote kept stands
 *      for a DIFFERENT message of the chat.
 *   3. Only a HIGH-confidence answer with TWO verified quotes, from two
 *      different messages, changes a setting (`planSetup`), and only when
 *      the setting is still at its default and the organiser has not saved
 *      it on /admin/settings (`settingsSetByOrganiser`). Anything else is
 *      recorded as `kept`, with the reason ("thin-evidence" for one
 *      quote). The first live check (2026-10-05) switched "organisers
 *      pick" on for a group on one line, "let's find someone for his
 *      place": one message is a moment, two are a habit.
 *   4. The weekly game (day, time, venue, size) and the language were
 *      entered by the organiser when the club was created on the website,
 *      so they are NEVER changed: when the chat clearly says something
 *      different, it becomes a SUGGESTION in the DM with a link.
 *   5. A monthly list (regulars prepay the month, PAYG fill-ins, credits
 *      for missed games) has no setting yet (the monthly squad mode is
 *      being built): it is NOTED, shown in the DM and on /admin/settings
 *      and /admin/clubs. Seen with HIGH confidence it switches NOTHING on:
 *      a group that runs by the month is not run by the weekly settings,
 *      and the same live check switched rolling squad and organisers pick
 *      on for one. At medium confidence it still holds payment tracking
 *      off, because tracking works game by game and would chase players
 *      who paid for the month.
 */
import type { HistoryMessage } from "../onboarding-enrichment-reconcile";
import { formatLondon } from "../london-time";
import {
  validateWeeklyDeadlines,
  type ActivitySlot,
  type WeeklyDeadlineError,
} from "../weekly-deadlines";
import { DAY_NAMES, type Confidence } from "./prompt";

// ── 1. Is there enough chat to read? ────────────────────────────────────

/** Fewer than this many messages: nothing is read. */
export const MIN_MESSAGES = 20;
/** Fewer than this many different people: nothing is read. */
export const MIN_AUTHORS = 3;
/** The newest messages that fit in this many characters are sent. About
 *  15k Haiku tokens, roughly $0.015 of input. */
export const MAX_INPUT_CHARS = 60_000;
/** One message is cut to this many characters (a pasted list is long). */
export const MAX_MESSAGE_CHARS = 400;

export type GateResult =
  | { ok: true; messages: number; authors: number }
  | { ok: false; reason: "no-history" | "too-short"; messages: number; authors: number };

export function historyGate(history: HistoryMessage[]): GateResult {
  const messages = history.length;
  const authors = new Set(history.map((m) => m.author.trim().toLowerCase())).size;
  if (messages === 0) return { ok: false, reason: "no-history", messages, authors };
  if (messages < MIN_MESSAGES || authors < MIN_AUTHORS) return { ok: false, reason: "too-short", messages, authors };
  return { ok: true, messages, authors };
}

// ── 2. What the model is shown ─────────────────────────────────────────

export interface WeeklyGameState {
  dayOfWeek: number;
  time: string;
  venue: string | null;
  playersPerSide: number | null;
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " / ").replace(/\s+/g, " ").trim();
}

/**
 * The user turn: the group's name, the weekly game the organiser entered,
 * and the newest messages that fit MAX_INPUT_CHARS, oldest first, each
 * as "[Mon 29 Sep 21:57] Author: text" in London time.
 */
export function buildUserContent(args: {
  groupSubject: string | null;
  weeklyGame: WeeklyGameState | null;
  history: HistoryMessage[];
}): { text: string; sent: number } {
  const lines: string[] = [];
  let used = 0;
  for (let i = args.history.length - 1; i >= 0; i--) {
    const m = args.history[i];
    const when = new Date(m.timestamp);
    const stamp = Number.isNaN(when.getTime()) ? "?" : formatLondon(when, "EEE d MMM HH:mm");
    let body = oneLine(m.text);
    if (body.length > MAX_MESSAGE_CHARS) body = `${body.slice(0, MAX_MESSAGE_CHARS)}…`;
    const line = `[${stamp}] ${oneLine(m.author)}: ${body}`;
    if (used + line.length + 1 > MAX_INPUT_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  lines.reverse();
  const g = args.weeklyGame;
  const entry = g
    ? `${DAY_NAMES[g.dayOfWeek] ?? "unknown day"} ${g.time}` +
      (g.venue ? ` at ${g.venue}` : "") +
      (g.playersPerSide ? `, ${g.playersPerSide} a side` : "")
    : "none entered";
  const text = [
    `Group name: ${args.groupSubject ? oneLine(args.groupSubject) : "(no name)"}`,
    `Weekly game the organiser entered: ${entry}`,
    `Messages (${lines.length}, oldest first, London time):`,
    lines.join("\n"),
  ].join("\n\n");
  return { text, sent: lines.length };
}

// ── 3. The model's answer, parsed and checked ──────────────────────────

export interface Answer<A extends string> {
  answer: A;
  confidence: Confidence;
  evidence: string[];
}
export interface DayTimeAnswer {
  day: number | null;
  time: string | null;
  confidence: Confidence;
  evidence: string[];
}
export interface Detection {
  regularGame: boolean;
  squad: Answer<"rolling" | "sign_up_each_week" | "unclear">;
  openPlaces: Answer<"organisers_pick" | "first_to_ask" | "unclear">;
  dropOutDeadline: DayTimeAnswer;
  listPublished: DayTimeAnswer;
  payments: Answer<"players_confirm_paying" | "no_sign">;
  monthlyList: Answer<"monthly_list" | "no_sign"> & {
    prepayForMonth: boolean;
    payAsYouGoFillIns: boolean;
    creditForMissedGames: boolean;
  };
  weeklyGame: {
    day: number | null;
    time: string | null;
    venue: string | null;
    playersPerSide: number | null;
    confidence: Confidence;
    evidence: string[];
  };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_QUOTE_CHARS = 140;

/** Lower case, invisible marks removed, every run of space one space. */
export function normaliseForMatch(s: string): string {
  return s
    .replace(/[​-‏⁠-⁩﻿]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** A setting is switched only on this many quotes, each from its own message. */
export const MIN_QUOTES_TO_APPLY = 2;
/** At most this many quotes are kept for one answer. */
const MAX_QUOTES = 2;

/**
 * The quotes that really are in the chat, at most two, in the model's
 * order, EACH STANDING FOR A DIFFERENT MESSAGE. A quote is kept when,
 * normalised, it is a substring of a normalised message that no quote
 * kept before it stands for. So two quotes cut from one message count
 * once, and the same sentence posted again another week may be quoted
 * twice: it is a second message. The length of the result is therefore
 * the number of separate messages behind an answer, which is what
 * `planSetup` counts. Quotes with six or more digits in a row are dropped
 * whatever they match: they are account numbers or phone numbers, and
 * they never go in a DM.
 */
export function verifyEvidence(raw: unknown, history: HistoryMessage[]): string[] {
  if (!Array.isArray(raw)) return [];
  const haystack = history.map((m) => normaliseForMatch(m.text));
  const kept: Array<{ quote: string; in: number[]; at: number }> = [];
  const taken = () => new Set(kept.map((k) => k.at));
  for (const q of raw) {
    if (typeof q !== "string") continue;
    const quote = q.replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
    if (quote.length < 3 || quote.length > MAX_QUOTE_CHARS) continue;
    if (/\d{6,}/.test(quote.replace(/[\s-]/g, ""))) continue;
    const n = normaliseForMatch(quote);
    const found = haystack.flatMap((h, i) => (h.includes(n) ? [i] : []));
    if (found.length === 0) continue;
    let at = found.find((i) => !taken().has(i));
    if (at === undefined) {
      // Every message with this quote already stands for an earlier one:
      // move that earlier quote to another of its messages if it has one.
      const holder = kept.find((k) => found.includes(k.at) && k.in.some((i) => !taken().has(i)));
      if (!holder) continue;
      at = holder.at;
      holder.at = holder.in.find((i) => !taken().has(i))!;
    }
    kept.push({ quote, in: found, at });
    if (kept.length === MAX_QUOTES) break;
  }
  return kept.map((k) => k.quote);
}

function pick<A extends string>(v: unknown, allowed: readonly A[], fallback: A): A {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as A) : fallback;
}
function conf(v: unknown): Confidence {
  return pick(v, ["high", "medium", "low"] as const, "low");
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function dayOf(v: unknown): number | null {
  const i = typeof v === "string" ? (DAY_NAMES as readonly string[]).indexOf(v.toLowerCase()) : -1;
  return i >= 0 ? i : null;
}
function timeOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const t = `${m[1].padStart(2, "0")}:${m[2]}`;
  return TIME_RE.test(t) ? t : null;
}

/** An answer that claims something but has no verified quote is "low". */
function answer<A extends string>(
  raw: unknown,
  allowed: readonly A[],
  none: A,
  history: HistoryMessage[],
): Answer<A> {
  const o = obj(raw);
  const a = pick(o.answer, allowed, none);
  const evidence = a === none ? [] : verifyEvidence(o.evidence, history);
  const confidence = a !== none && evidence.length === 0 ? "low" : conf(o.confidence);
  return { answer: a, confidence, evidence };
}

function dayTime(raw: unknown, history: HistoryMessage[]): DayTimeAnswer {
  const o = obj(raw);
  const day = dayOf(o.day);
  const time = timeOf(o.time);
  const found = day !== null && time !== null;
  const evidence = found ? verifyEvidence(o.evidence, history) : [];
  return {
    day: found ? day : null,
    time: found ? time : null,
    confidence: found && evidence.length > 0 ? conf(o.confidence) : "low",
    evidence,
  };
}

/** Null when the response is not an object at all (the caller records a model error). */
export function parseDetection(raw: unknown, history: HistoryMessage[]): Detection | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const regularGame = o.regular_game === true;
  const ml = obj(o.monthly_list);
  const monthly = answer(ml, ["monthly_list", "no_sign"] as const, "no_sign", history);
  const yes = monthly.answer === "monthly_list";
  const wg = obj(o.weekly_game);
  const wgDay = dayOf(wg.day);
  const wgTime = timeOf(wg.time);
  const venue = typeof wg.venue === "string" && wg.venue.trim() ? wg.venue.replace(/\s+/g, " ").trim().slice(0, 80) : null;
  const pps =
    typeof wg.players_per_side === "number" && Number.isInteger(wg.players_per_side) && wg.players_per_side >= 3 && wg.players_per_side <= 11
      ? wg.players_per_side
      : null;
  const wgClaims = wgDay !== null || wgTime !== null || venue !== null || pps !== null;
  const wgEvidence = wgClaims ? verifyEvidence(wg.evidence, history) : [];
  return {
    regularGame,
    squad: answer(o.squad, ["rolling", "sign_up_each_week", "unclear"] as const, "unclear", history),
    openPlaces: answer(o.open_places, ["organisers_pick", "first_to_ask", "unclear"] as const, "unclear", history),
    dropOutDeadline: dayTime(o.drop_out_deadline, history),
    listPublished: dayTime(o.list_published, history),
    payments: answer(o.payments, ["players_confirm_paying", "no_sign"] as const, "no_sign", history),
    monthlyList: {
      ...monthly,
      prepayForMonth: yes && ml.prepay_for_month === true,
      payAsYouGoFillIns: yes && ml.pay_as_you_go_fill_ins === true,
      creditForMissedGames: yes && ml.credit_for_missed_games === true,
    },
    weeklyGame: {
      day: wgDay,
      time: wgTime,
      venue,
      playersPerSide: pps,
      confidence: wgClaims && wgEvidence.length > 0 ? conf(wg.confidence) : "low",
      evidence: wgEvidence,
    },
  };
}

// ── 4. What to change, suggest and note ────────────────────────────────

/** The settings the learned setup may switch. */
export const LEARNED_KEYS = ["rollingSquad", "organiserPicks", "dropOutDeadline", "listPublish", "paymentTracking"] as const;
export type LearnedKey = (typeof LEARNED_KEYS)[number];

/** The `settingsSetByOrganiser` entry for each learned key: the patch key
 *  `setWeeklyRoutine` / `setOrgFeature` records when the organiser saves it. */
export const ORGANISER_SET_KEY: Record<LearnedKey, string> = {
  rollingSquad: "rollingSquad",
  organiserPicks: "benchPickMode",
  dropOutDeadline: "dropOutDeadline",
  listPublish: "listPublish",
  paymentTracking: "paymentTracking",
};

export const SUGGESTION_KEYS = ["weeklyGameDay", "weeklyGameTime", "venue", "format", "language"] as const;
export type SuggestionKey = (typeof SUGGESTION_KEYS)[number];

export interface OrgSettingsState {
  rollingSquadEnabled: boolean;
  benchPickMode: string;
  dropOutDeadlineDay: number | null;
  dropOutDeadlineTime: string | null;
  listPublishDay: number | null;
  listPublishTime: string | null;
  paymentTrackingEnabled: boolean;
  language: string;
  settingsSetByOrganiser: string[];
}

export type DayTimeValue = { day: number; time: string };
export type SettingValue = boolean | string | DayTimeValue | null;

export interface AppliedItem {
  key: LearnedKey;
  from: SettingValue;
  to: SettingValue;
  evidence: string[];
  /** Set when the organiser undid it from /admin/settings. */
  undoneAt?: string | null;
}
export interface Suggestion {
  key: SuggestionKey;
  /** What the club has now (day index as a string, time, venue, size, language code). */
  current: string;
  /** What the chat shows. */
  detected: string;
  evidence: string[];
}
export interface NotedPattern {
  key: "monthlyList";
  prepayForMonth: boolean;
  payAsYouGoFillIns: boolean;
  creditForMissedGames: boolean;
  confidence: Confidence;
  evidence: string[];
  /** Payment tracking was detected but left off because of this. */
  heldPaymentTracking: boolean;
}
export type KeptReason =
  | "organiser-set"
  | "already"
  | "not-default"
  | "monthly-list"
  /** High confidence, but fewer than MIN_QUOTES_TO_APPLY messages behind it. */
  | "thin-evidence"
  | `invalid:${WeeklyDeadlineError}`;
export interface KeptItem {
  key: LearnedKey;
  reason: KeptReason;
}

/** The Organisation columns to write, keyed as Prisma names them. */
export interface SetupData {
  rollingSquadEnabled?: boolean;
  benchPickMode?: string;
  dropOutDeadlineDay?: number;
  dropOutDeadlineTime?: string;
  listPublishDay?: number;
  listPublishTime?: string;
  paymentTrackingEnabled?: boolean;
}

export interface SetupPlan {
  applied: AppliedItem[];
  suggestions: Suggestion[];
  noted: NotedPattern[];
  kept: KeptItem[];
  data: SetupData;
}

/** Enough to SUGGEST or note: high confidence and a quote from the chat. */
function shown(a: { confidence: Confidence; evidence: string[] }): boolean {
  return a.confidence === "high" && a.evidence.length > 0;
}
/** Enough to CHANGE a setting: also two quotes, each from its own message. */
function proven(a: { confidence: Confidence; evidence: string[] }): boolean {
  return shown(a) && a.evidence.length >= MIN_QUOTES_TO_APPLY;
}

export function currentValue(key: LearnedKey, org: OrgSettingsState): SettingValue {
  switch (key) {
    case "rollingSquad":
      return org.rollingSquadEnabled;
    case "organiserPicks":
      return org.benchPickMode;
    case "paymentTracking":
      return org.paymentTrackingEnabled;
    case "dropOutDeadline":
      return org.dropOutDeadlineDay != null && org.dropOutDeadlineTime != null
        ? { day: org.dropOutDeadlineDay, time: org.dropOutDeadlineTime }
        : null;
    case "listPublish":
      return org.listPublishDay != null && org.listPublishTime != null
        ? { day: org.listPublishDay, time: org.listPublishTime }
        : null;
  }
}

/** Each key's value when nobody has touched it (the column defaults). */
export const DEFAULT_VALUE: Record<LearnedKey, SettingValue> = {
  rollingSquad: false,
  organiserPicks: "first-come",
  paymentTracking: false,
  dropOutDeadline: null,
  listPublish: null,
};

export function sameValue(a: SettingValue, b: SettingValue): boolean {
  if (a && b && typeof a === "object" && typeof b === "object") return a.day === b.day && a.time === b.time;
  return a === b;
}

/** The column write that puts `key` to `value`. */
export function dataFor(key: LearnedKey, value: SettingValue): SetupData & Record<string, unknown> {
  switch (key) {
    case "rollingSquad":
      return { rollingSquadEnabled: value === true };
    case "organiserPicks":
      return { benchPickMode: value === "organiser" ? "organiser" : "first-come" };
    case "paymentTracking":
      return { paymentTrackingEnabled: value === true };
    case "dropOutDeadline": {
      const v = value as DayTimeValue | null;
      return { dropOutDeadlineDay: v ? v.day : null, dropOutDeadlineTime: v ? v.time : null } as SetupData & Record<string, unknown>;
    }
    case "listPublish": {
      const v = value as DayTimeValue | null;
      return { listPublishDay: v ? v.day : null, listPublishTime: v ? v.time : null } as SetupData & Record<string, unknown>;
    }
  }
}

function sameVenue(a: string, b: string): boolean {
  const x = normaliseForMatch(a).replace(/[^\p{L}\p{N} ]/gu, "");
  const y = normaliseForMatch(b).replace(/[^\p{L}\p{N} ]/gu, "");
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

export function planSetup(args: {
  detection: Detection;
  org: OrgSettingsState;
  weeklyGame: WeeklyGameState | null;
  /** Every active activity of the club, for the deadline checks. */
  activities: ActivitySlot[];
  /** From `detectGroupLang` on the same chat (no model). */
  chatLanguage: { lang: string; confident: boolean } | null;
}): SetupPlan {
  const { detection: d, org } = args;
  const plan: SetupPlan = { applied: [], suggestions: [], noted: [], kept: [], data: {} };
  if (!d.regularGame) return plan;

  const organiserSet = new Set(org.settingsSetByOrganiser);

  // Monthly list: noted, never applied. Seen with high confidence it
  // switches nothing on at all; otherwise it holds payment tracking off.
  const monthly = d.monthlyList.answer === "monthly_list" && d.monthlyList.confidence !== "low";
  const monthlyHoldsAll = monthly && d.monthlyList.confidence === "high";
  const paymentsProven = d.payments.answer === "players_confirm_paying" && proven(d.payments);
  if (monthly) {
    plan.noted.push({
      key: "monthlyList",
      prepayForMonth: d.monthlyList.prepayForMonth,
      payAsYouGoFillIns: d.monthlyList.payAsYouGoFillIns,
      creditForMissedGames: d.monthlyList.creditForMissedGames,
      confidence: d.monthlyList.confidence,
      evidence: d.monthlyList.evidence,
      heldPaymentTracking: paymentsProven,
    });
  }

  const candidates: Array<{ key: LearnedKey; to: SettingValue; evidence: string[] }> = [];
  const consider = (key: LearnedKey, to: SettingValue, a: { confidence: Confidence; evidence: string[] }) => {
    if (!shown(a)) return;
    if (!proven(a)) plan.kept.push({ key, reason: "thin-evidence" });
    else if (monthlyHoldsAll || (monthly && key === "paymentTracking")) plan.kept.push({ key, reason: "monthly-list" });
    else candidates.push({ key, to, evidence: a.evidence });
  };
  if (d.squad.answer === "rolling") consider("rollingSquad", true, d.squad);
  if (d.openPlaces.answer === "organisers_pick") consider("organiserPicks", "organiser", d.openPlaces);
  if (d.dropOutDeadline.day !== null && d.dropOutDeadline.time !== null) {
    consider("dropOutDeadline", { day: d.dropOutDeadline.day, time: d.dropOutDeadline.time }, d.dropOutDeadline);
  }
  if (d.listPublished.day !== null && d.listPublished.time !== null) {
    consider("listPublish", { day: d.listPublished.day, time: d.listPublished.time }, d.listPublished);
  }
  if (d.payments.answer === "players_confirm_paying") consider("paymentTracking", true, d.payments);

  const accepted: typeof candidates = [];
  for (const c of candidates) {
    const now = currentValue(c.key, org);
    if (organiserSet.has(ORGANISER_SET_KEY[c.key])) plan.kept.push({ key: c.key, reason: "organiser-set" });
    else if (sameValue(now, c.to)) plan.kept.push({ key: c.key, reason: "already" });
    else if (!sameValue(now, DEFAULT_VALUE[c.key])) plan.kept.push({ key: c.key, reason: "not-default" });
    else accepted.push(c);
  }

  // The two deadlines must pass the same checks the settings page runs,
  // together. When the pair fails, each is tried alone (the drop-out
  // deadline first: it is the one the group feels).
  const deadline = accepted.find((c) => c.key === "dropOutDeadline");
  const publish = accepted.find((c) => c.key === "listPublish");
  const base = {
    dropOutDeadlineDay: org.dropOutDeadlineDay,
    dropOutDeadlineTime: org.dropOutDeadlineTime,
    listPublishDay: org.listPublishDay,
    listPublishTime: org.listPublishTime,
  };
  const withPair = (c: (typeof candidates)[number] | undefined, into: typeof base) => {
    if (!c) return into;
    const v = c.to as DayTimeValue;
    return c.key === "dropOutDeadline"
      ? { ...into, dropOutDeadlineDay: v.day, dropOutDeadlineTime: v.time }
      : { ...into, listPublishDay: v.day, listPublishTime: v.time };
  };
  const rejected = new Map<LearnedKey, WeeklyDeadlineError>();
  if (deadline || publish) {
    const both = validateWeeklyDeadlines(withPair(publish, withPair(deadline, base)), args.activities);
    if (both) {
      let kept = base;
      for (const c of [deadline, publish]) {
        if (!c) continue;
        const err = validateWeeklyDeadlines(withPair(c, kept), args.activities);
        if (err) rejected.set(c.key, err);
        else kept = withPair(c, kept);
      }
    }
  }

  for (const c of accepted) {
    const err = rejected.get(c.key);
    if (err) {
      plan.kept.push({ key: c.key, reason: `invalid:${err}` });
      continue;
    }
    plan.applied.push({ key: c.key, from: currentValue(c.key, org), to: c.to, evidence: c.evidence, undoneAt: null });
    Object.assign(plan.data, dataFor(c.key, c.to));
  }

  // The weekly game and the language: suggestions only.
  const g = args.weeklyGame;
  const w = d.weeklyGame;
  if (g && shown(w)) {
    if (w.day !== null && w.day !== g.dayOfWeek) {
      plan.suggestions.push({ key: "weeklyGameDay", current: String(g.dayOfWeek), detected: String(w.day), evidence: w.evidence });
    }
    if (w.time !== null && w.time !== g.time) {
      plan.suggestions.push({ key: "weeklyGameTime", current: g.time, detected: w.time, evidence: w.evidence });
    }
    if (w.venue && g.venue && !sameVenue(w.venue, g.venue)) {
      plan.suggestions.push({ key: "venue", current: g.venue, detected: w.venue, evidence: w.evidence });
    }
    if (w.playersPerSide !== null && g.playersPerSide !== null && w.playersPerSide !== g.playersPerSide) {
      plan.suggestions.push({
        key: "format",
        current: String(g.playersPerSide),
        detected: String(w.playersPerSide),
        evidence: w.evidence,
      });
    }
  }
  const cl = args.chatLanguage;
  if (cl && cl.confident && cl.lang !== org.language && !organiserSet.has("language")) {
    plan.suggestions.push({ key: "language", current: org.language, detected: cl.lang, evidence: [] });
  }
  return plan;
}

/** Does the plan give the organiser anything worth a DM? */
export function planIsWorthTelling(plan: SetupPlan): boolean {
  return plan.applied.length > 0 || plan.suggestions.length > 0 || plan.noted.length > 0;
}
