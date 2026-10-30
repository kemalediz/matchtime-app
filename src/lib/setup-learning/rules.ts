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
 *   4. WHO FILLS AN OPEN PLACE IS NEVER SWITCHED (2026-10-06). "Organisers
 *      pick" changes who gets a place, so it is the most consequential
 *      setting here, and it is the one the model over-reads: the second
 *      live check gave it "high" with two real quotes from two messages
 *      ("anyone got a mate who can cover?", "Sorted, thanks Dev") for an
 *      organiser who had sorted ONE replacement. Two quotes cannot tell a
 *      standing habit from that. So the same evidence that would have
 *      switched it now makes a SUGGESTION: the organiser is asked, shown
 *      the messages and given a link to the setting. Rolling squad, the
 *      two deadlines and payment tracking are still switched under rule 3.
 *   5. The weekly game (day, time, venue, size) and the language were
 *      entered by the organiser when the club was created on the website,
 *      so they are NEVER changed: when the chat clearly says something
 *      different about the game, it becomes a SUGGESTION in the DM with a
 *      link. The language is never suggested (2026-10-30): it is not
 *      guessed from the chat.
 *   6. A monthly list (regulars prepay the month, PAYG fill-ins, credits
 *      for missed games) is never switched from the chat (Monthly squad
 *      in Settings is the organiser's own choice; the DM points at it):
 *      it is NOTED, shown in the DM and on /admin/settings and
 *      /admin/clubs. Seen with HIGH confidence it switches NOTHING on:
 *      a group that runs by the month is not run by the weekly settings,
 *      and the same live check switched rolling squad and organisers pick
 *      on for one. At medium confidence it still holds payment tracking
 *      off, because tracking works game by game and would chase players
 *      who paid for the month.
 *   7. THE GROUP DESCRIPTION IS ONE SOURCE, NEVER TWO (go-live slice D3,
 *      2026-10-12). The description WhatsApp shared at the add (already
 *      masked, group-description.ts) is shown to the model beside the
 *      chat, and a quote may be found in it. Every quote kept for an
 *      answer stands for a different source: a different message, or the
 *      description, which is ONE source however many of its sentences
 *      are quoted. So rule 3 reads on unchanged: description + one
 *      message agreeing is two sources and may switch a setting; the
 *      description twice, or alone, is one and switches nothing. THE
 *      SERVER decides which source a quote came from, by finding it
 *      (`verifyEvidenceTagged`); the model is never asked. A quote found
 *      in a message counts as that message even when the description
 *      says the same. The quotes that are the description's are listed in
 *      `fromDescription` beside `evidence`, only when there are any, so a
 *      row written before this slice reads exactly as it did.
 *      "[number removed]", "[link removed]" and "[email removed]" are
 *      what the masking left behind: a DESCRIPTION quote that overlaps or
 *      touches one is dropped, decided by where the quote sits and not by
 *      how it is spelt. A description quote must also be more than a
 *      scrap (two words or eight characters). A chat quote is held to
 *      neither: chat is never masked. EVERY quote, from either source,
 *      must be whole words: "paid" is not in "Unpaid".
 *      Nothing is read from the description alone: when the chat fails
 *      `historyGate`, the description is not read either.
 *   8. THE MATCH FEE IS ONLY EVER SUGGESTED (same slice). When the text
 *      states what each player pays for a game, in pounds, and the club's
 *      weekly game has no fee or a different one, the organiser is asked,
 *      with a link. The MODEL says the amount and that it is per player
 *      (`basis`, read by its own call, fee-basis.ts, 2026-10-30); THE EVIDENCE NEEDED: a verified quote that
 *      holds the number (`quoteHasAmount`), from the description (one is
 *      enough: it is the group's standing notice, and a suggestion changes
 *      nothing), or from TWO different messages (one message may be a
 *      single week's price). An out-of-date description is the model's
 *      ruling. Never for a group that runs a monthly list (by the
 *      model's answer OR by the club's stored squad mode) or splits the
 *      pitch cost: neither has one fixed fee a game.
 */
import type { HistoryMessage } from "../onboarding-enrichment-reconcile";
import { formatLondon } from "../london-time";
import { isFeatureOffered } from "../org-features-meta";
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
  /** `Activity.feePerPlayer`, in pounds. Absent or null: no fee is set. */
  feePerPlayer?: number | null;
  /** `Activity.feeSplitTotal`: the pitch cost is split, there is no fixed fee. */
  feeSplitTotal?: boolean;
}

/** The description is cut to this many characters before it is sent. */
export const MAX_DESCRIPTION_CHARS = 2_000;

/**
 * The description as the model is shown it AND as quotes are checked
 * against it (one function, so the two can never differ): trimmed, cut to
 * MAX_DESCRIPTION_CHARS, null when there is nothing. It arrives masked
 * (group-description.ts); nothing here unmasks or logs it.
 */
export function descriptionForReading(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/"{3,}/g, '"').trim().slice(0, MAX_DESCRIPTION_CHARS).trim();
  return text ? text : null;
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " / ").replace(/\s+/g, " ").trim();
}

/**
 * The user turn: the group's name, the weekly game the organiser entered,
 * the group description as its own labelled block (or "(none)"), and the
 * newest messages that fit MAX_INPUT_CHARS, oldest first, each as
 * "[Mon 29 Sep 21:57] Author: text" in London time. The description keeps
 * its line breaks; what its placeholders mean is said once, in the prompt.
 */
export function buildUserContent(args: {
  groupSubject: string | null;
  weeklyGame: WeeklyGameState | null;
  history: HistoryMessage[];
  /** `ClubConnect.capturedDescription`, already masked. */
  description?: string | null;
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
  const description = descriptionForReading(args.description);
  const text = [
    `Group name: ${args.groupSubject ? oneLine(args.groupSubject) : "(no name)"}`,
    `Weekly game the organiser entered: ${entry}`,
    description
      ? `Group description (one source, written by a group admin, maybe long ago):\n"""\n${description}\n"""`
      : `Group description: (none)`,
    `Messages (${lines.length}, oldest first, London time):`,
    lines.join("\n"),
  ].join("\n\n");
  return { text, sent: lines.length };
}

// ── 3. The model's answer, parsed and checked ──────────────────────────

/** Where a verified quote was found. */
export type EvidenceSource = "chat" | "description";
export interface VerifiedQuote {
  quote: string;
  source: EvidenceSource;
}
/**
 * The verified quotes behind an answer, each standing for a different
 * source. `fromDescription` lists the ones (at most one) found in the
 * group description, and is ABSENT when none was.
 */
export interface Evidenced {
  evidence: string[];
  fromDescription?: string[];
}
export interface Answer<A extends string> extends Evidenced {
  answer: A;
  confidence: Confidence;
}
export interface DayTimeAnswer extends Evidenced {
  day: number | null;
  time: string | null;
  confidence: Confidence;
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
  } & Evidenced;
  /** What each player pays for a game, in pounds. `amount` is null unless
   *  a verified quote contains it; every quote kept does. */
  matchFee: { amount: number | null; confidence: Confidence } & Evidenced;
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

/** A letter or a digit, in any alphabet (Turkish ı, ş, ğ, ç, ö, ü included). */
const WORD_CHAR = /[\p{L}\p{N}]/u;
const isWordChar = (c: string | undefined): boolean => c !== undefined && WORD_CHAR.test(c);

/**
 * Where `needle` sits in `hay` AS WHOLE WORDS: every start index at which
 * it is found without cutting a word at either end. "paid" is not in
 * "Unpaid", "sit ou" is not in "sit out". A needle that begins or ends on
 * punctuation has nothing to cut at that end. (Review fix 2: until then a
 * quote was any substring.)
 */
function wholeWordStarts(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const end = i + needle.length;
    const cutsStart = isWordChar(needle[0]) && isWordChar(hay[i - 1]);
    const cutsEnd = isWordChar(needle[needle.length - 1]) && isWordChar(hay[end]);
    if (!cutsStart && !cutsEnd) out.push(i);
  }
  return out;
}

/** What the masking of the description leaves behind (group-description.ts),
 *  as it reads once normalised. */
const MASKED_SPAN = /\[(?:number|link|email) removed\]/g;
/** A description quote needs this many characters, or two words. */
const MIN_DESCRIPTION_QUOTE_CHARS = 8;

/**
 * The description, ready to be searched. `text` is it normalised (one
 * line, as a quote is normalised); `lines` is the same string with each
 * line break kept as "\n" at the same index, so a position in one is the
 * same position in the other; `masked` is where the masking's
 * placeholders sit.
 */
interface SearchableDescription {
  text: string;
  lines: string;
  masked: Array<[number, number]>;
}
function searchable(sent: string): SearchableDescription {
  const parts = sent.split(/\n+/).map(normaliseForMatch).filter(Boolean);
  const text = parts.join(" ");
  return { text, lines: parts.join("\n"), masked: [...text.matchAll(MASKED_SPAN)].map((m) => [m.index, m.index + m[0].length]) };
}

/**
 * Is `needle` in the description as the group's own words? (Review fixes
 * 1 and 2.) It must be whole words, more than a scrap (two words, or
 * MIN_DESCRIPTION_QUOTE_CHARS characters), and sit somewhere that neither
 * OVERLAPS a masked span nor TOUCHES one. Decided by position, so a
 * fragment of a placeholder is refused however it is spelt ("number
 * removed", "removed]", a dangling "["), and so are the words right beside
 * one ("Send it to Dave", "by Friday"), which would imply what stood
 * there. Touching: nothing between the two but spaces and commas. A full
 * stop, a colon, a line break or another word ends it, so the next
 * sentence and the next line may be quoted.
 */
function inDescription(d: SearchableDescription, needle: string): boolean {
  if (needle.length < MIN_DESCRIPTION_QUOTE_CHARS && !/\S\s\S/.test(needle)) return false;
  const separates = /[\p{L}\p{N}.!?;:\n]/u;
  return wholeWordStarts(d.text, needle).some((start) => {
    const end = start + needle.length;
    return d.masked.every(([from, to]) => {
      if (start < to && from < end) return false;
      const gap = end <= from ? d.lines.slice(end, from) : d.lines.slice(to, start);
      return separates.test(gap);
    });
  });
}

/**
 * The quotes that really are in the chat or the group description, at
 * most two, in the model's order, EACH STANDING FOR A DIFFERENT SOURCE,
 * and tagged with the source it stands for. A quote is kept when,
 * normalised, it is found AS WHOLE WORDS in a normalised message (or in
 * the description) that no quote kept before it stands for. So:
 *   - two quotes cut from one message count once;
 *   - the same sentence posted again another week may be quoted twice: it
 *     is a second message;
 *   - THE DESCRIPTION IS ONE SOURCE: two quotes from it count once;
 *   - a quote found in a message stands for the message, even when the
 *     description says the same (a message is how the group runs now);
 *     it moves to the description only to make room for a later quote
 *     that is in that message alone.
 * The length of the result is therefore the number of separate sources
 * behind an answer, which is what `planSetup` counts. Dropped whatever
 * they match: quotes with six or more digits in a row (account numbers or
 * phone numbers: they never go in a DM).
 *
 * THE DESCRIPTION IS HELD TO MORE THAN A MESSAGE (`inDescription`): it was
 * masked before it was stored, so a quote must keep clear of what the
 * masking left, and it is one text a short word can be fished out of, so
 * a quote must be more than a scrap. NONE OF THAT APPLIES TO A MESSAGE
 * (review fix 4): chat is never masked, and a line like "[link to pitch]
 * here" is somebody's own words. With no description, the only thing
 * that differs from before slice D3 is the whole-word rule.
 */
export function verifyEvidenceTagged(raw: unknown, history: HistoryMessage[], description?: string | null): VerifiedQuote[] {
  if (!Array.isArray(raw)) return [];
  const haystack = history.map((m) => normaliseForMatch(m.text));
  // The description is the last source: found after every message, so a
  // quote prefers a message. Its index says which source a quote is.
  const sent = descriptionForReading(description);
  const desc = sent ? searchable(sent) : null;
  const descriptionAt = desc ? haystack.length : -1;
  const kept: Array<{ quote: string; in: number[]; at: number }> = [];
  const taken = () => new Set(kept.map((k) => k.at));
  for (const q of raw) {
    if (typeof q !== "string") continue;
    const quote = q.replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
    if (quote.length < 3 || quote.length > MAX_QUOTE_CHARS) continue;
    if (/\d{6,}/.test(quote.replace(/[\s-]/g, ""))) continue;
    const n = normaliseForMatch(quote);
    const found = haystack.flatMap((h, i) => (wholeWordStarts(h, n).length > 0 ? [i] : []));
    if (desc && inDescription(desc, n)) found.push(descriptionAt);
    if (found.length === 0) continue;
    let at = found.find((i) => !taken().has(i));
    if (at === undefined) {
      // Every source with this quote already stands for an earlier one:
      // move that earlier quote to another of its sources if it has one.
      const holder = kept.find((k) => found.includes(k.at) && k.in.some((i) => !taken().has(i)));
      if (!holder) continue;
      at = holder.at;
      holder.at = holder.in.find((i) => !taken().has(i))!;
    }
    kept.push({ quote, in: found, at });
    if (kept.length === MAX_QUOTES) break;
  }
  return kept.map((k) => ({ quote: k.quote, source: k.at === descriptionAt ? "description" : "chat" }));
}

/** The verified quotes alone, in order (see `verifyEvidenceTagged`). */
export function verifyEvidence(raw: unknown, history: HistoryMessage[], description?: string | null): string[] {
  return verifyEvidenceTagged(raw, history, description).map((v) => v.quote);
}

/** The text a model answer is checked against. */
interface Sources {
  history: HistoryMessage[];
  description: string | null;
}

/** Verified quotes as an answer carries them; `fromDescription` only when there is one. */
function evidenced(tagged: VerifiedQuote[]): Evidenced {
  const fromDescription = tagged.filter((v) => v.source === "description").map((v) => v.quote);
  return { evidence: tagged.map((v) => v.quote), ...(fromDescription.length > 0 ? { fromDescription } : {}) };
}
const NO_EVIDENCE: Evidenced = { evidence: [] };
function checked(raw: unknown, src: Sources): Evidenced {
  return evidenced(verifyEvidenceTagged(raw, src.history, src.description));
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
  src: Sources,
): Answer<A> {
  const o = obj(raw);
  const a = pick(o.answer, allowed, none);
  const ev = a === none ? NO_EVIDENCE : checked(o.evidence, src);
  const confidence = a !== none && ev.evidence.length === 0 ? "low" : conf(o.confidence);
  return { answer: a, confidence, ...ev };
}

function dayTime(raw: unknown, src: Sources): DayTimeAnswer {
  const o = obj(raw);
  const day = dayOf(o.day);
  const time = timeOf(o.time);
  const found = day !== null && time !== null;
  const ev = found ? checked(o.evidence, src) : NO_EVIDENCE;
  return {
    day: found ? day : null,
    time: found ? time : null,
    confidence: found && ev.evidence.length > 0 ? conf(o.confidence) : "low",
    ...ev,
  };
}

/** A per-player fee below or above these, in pounds, is not believed. */
export const MIN_MATCH_FEE = 0.5;
export const MAX_MATCH_FEE = 50;

/**
 * A MODEL-OUTPUT VERIFIER (2026-10-30, no string parsing): does this quote
 * hold the amount the model stated, written as a number standing on its
 * own ("£6", "6 quid", "6.00", "£6,50")? A number run into letters ("6pm",
 * "6th", "7v7") is not one. It says nothing about what the words mean:
 * whether the number is a price, and a price for each player rather than
 * for the pitch, is the model's answer (`basis`, fee-basis.ts). This only stops a fee
 * the model worked out, made up, or quoted from a line without it.
 */
export function quoteHasAmount(quote: string, amount: number): boolean {
  const numbers = [...quote.matchAll(/(?<![\p{L}\p{N}.,])(\d+(?:[.,]\d{1,2})?)(?![\p{L}\p{N}]|[.,]\d)/gu)].map((m) => Number(m[1].replace(",", ".")));
  return numbers.some((n) => Math.abs(n - amount) < 0.005);
}

/**
 * The match fee: an amount in pounds that the MODEL says each player pays
 * (`basis` "per_player"; "whole_pitch" or anything else is no fee), kept
 * only with a verified quote that holds the number (`quoteHasAmount`).
 * Any other currency is no fee: the club's fee is held in pounds. Absent
 * from the answer (a stub, a reading before this slice, or one before
 * `basis`): no fee.
 *
 * Until 2026-10-30 the server also read the chat for other prices with a
 * word list (pitch, total, each, per head, kişi başı) and dropped the
 * description's quote when a message stated another. Both are the model's
 * rulings now: the fee-basis call (fee-basis.ts) and the reading prompt's
 * description rulings. No code reads what a person meant.
 */
function matchFee(raw: unknown, src: Sources): Detection["matchFee"] {
  const o = obj(raw);
  const none: Detection["matchFee"] = { amount: null, confidence: "low", evidence: [] };
  const n = typeof o.amount === "number" && Number.isFinite(o.amount) ? Math.round(o.amount * 100) / 100 : null;
  if (n === null || o.currency !== "pounds" || o.basis !== "per_player" || n < MIN_MATCH_FEE || n > MAX_MATCH_FEE) return none;
  const stated = verifyEvidenceTagged(
    Array.isArray(o.evidence) ? o.evidence.filter((q) => typeof q === "string" && quoteHasAmount(q, n)) : [],
    src.history,
    src.description,
  );
  if (stated.length === 0) return none;
  return { amount: n, confidence: conf(o.confidence), ...evidenced(stated) };
}

/** Null when the response is not an object at all (the caller records a model error). */
export function parseDetection(raw: unknown, history: HistoryMessage[], description?: string | null): Detection | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src: Sources = { history, description: descriptionForReading(description) };
  const o = raw as Record<string, unknown>;
  const regularGame = o.regular_game === true;
  const ml = obj(o.monthly_list);
  const monthly = answer(ml, ["monthly_list", "no_sign"] as const, "no_sign", src);
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
  const wgEvidence = wgClaims ? checked(wg.evidence, src) : NO_EVIDENCE;
  return {
    regularGame,
    squad: answer(o.squad, ["rolling", "sign_up_each_week", "unclear"] as const, "unclear", src),
    openPlaces: answer(o.open_places, ["organisers_pick", "first_to_ask", "unclear"] as const, "unclear", src),
    dropOutDeadline: dayTime(o.drop_out_deadline, src),
    listPublished: dayTime(o.list_published, src),
    payments: answer(o.payments, ["players_confirm_paying", "no_sign"] as const, "no_sign", src),
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
      confidence: wgClaims && wgEvidence.evidence.length > 0 ? conf(wg.confidence) : "low",
      ...wgEvidence,
    },
    matchFee: matchFee(o.match_fee, src),
  };
}

// ── 4. What to change, suggest and note ────────────────────────────────

/** The settings the learned setup knows. Every one but SUGGEST_ONLY may be
 *  switched; a key stays here when it is only suggested because `kept`
 *  still names it, and a row written before 2026-10-06 may hold it as
 *  switched (and must stay undoable). */
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

/** Never switched from the chat, whatever the evidence: suggested instead (rule 4). */
export const SUGGEST_ONLY: ReadonlySet<LearnedKey> = new Set<LearnedKey>(["organiserPicks"]);

export const SUGGESTION_KEYS = ["weeklyGameDay", "weeklyGameTime", "venue", "format", "language", "matchFee", "organiserPicks"] as const;
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
  /** The club's stored squad mode is the monthly one (run.ts reads it;
   *  nothing here ever writes it). Absent: weekly. */
  monthlySquad?: boolean;
}

export type DayTimeValue = { day: number; time: string };
export type SettingValue = boolean | string | DayTimeValue | null;

export interface AppliedItem extends Evidenced {
  key: LearnedKey;
  from: SettingValue;
  to: SettingValue;
  /** Set when the organiser undid it from /admin/settings. */
  undoneAt?: string | null;
}
export interface Suggestion extends Evidenced {
  key: SuggestionKey;
  /** What the club has now (day index as a string, time, venue, size,
   *  language code, the pick mode for "organiserPicks", or for "matchFee"
   *  the weekly game's fee in pounds, "" when it has none). */
  current: string;
  /** What the chat or the description shows. */
  detected: string;
}
export interface NotedPattern extends Evidenced {
  key: "monthlyList";
  prepayForMonth: boolean;
  payAsYouGoFillIns: boolean;
  creditForMissedGames: boolean;
  confidence: Confidence;
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
  /** The club was setting up when it was read and had gone live by the
   *  write (run.ts): a late reading changes nothing. */
  | "went-live"
  /** The club stopped being approved (it was suspended) between the read
   *  and the write (run.ts): nothing is changed. */
  | "no-longer-approved"
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

/** Enough to SUGGEST or note: high confidence and a verified quote. */
function shown(a: { confidence: Confidence; evidence: string[] }): boolean {
  return a.confidence === "high" && a.evidence.length > 0;
}
/** `fromDescription`, carried onto a plan item only when there is one. */
function source(a: Evidenced): { fromDescription?: string[] } {
  return a.fromDescription && a.fromDescription.length > 0 ? { fromDescription: a.fromDescription } : {};
}
/** A fee in pounds as the plan stores it: "6", "6.50". */
export function feeText(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
/** Enough to CHANGE a setting: also two quotes, each from its own source
 *  (two messages, or one message and the description: rule 7). */
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

/** Is this the same pitch? Also how the settings page tells whether a
 *  venue suggestion still stands (suggestion-state.ts). */
export function sameVenue(a: string, b: string): boolean {
  const x = normaliseForMatch(a).replace(/[^\p{L}\p{N} ]/gu, "");
  const y = normaliseForMatch(b).replace(/[^\p{L}\p{N} ]/gu, "");
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

/**
 * The plan without the settings that are hidden for now (payment tracking,
 * 2026-10-16, `HIDDEN_FEATURE_KEYS`): nothing switches them on, nothing
 * says one was left alone or held off. `planSetup` itself is unchanged (it
 * is pinned against main by main-parity.test.ts); run.ts filters every
 * plan it writes through this.
 */
export function hideUnofferedSettings(plan: SetupPlan): SetupPlan {
  const hidden = (key: LearnedKey) => !isFeatureOffered(key);
  const data = { ...plan.data };
  if (!isFeatureOffered("paymentTracking")) delete data.paymentTrackingEnabled;
  return {
    ...plan,
    applied: plan.applied.filter((a) => !hidden(a.key)),
    kept: plan.kept.filter((k) => !hidden(k.key)),
    noted: plan.noted.map((n) => (isFeatureOffered("paymentTracking") ? n : { ...n, heldPaymentTracking: false })),
    data,
  };
}

export function planSetup(args: {
  detection: Detection;
  org: OrgSettingsState;
  weeklyGame: WeeklyGameState | null;
  /** Every active activity of the club, for the deadline checks. */
  activities: ActivitySlot[];
}): SetupPlan {
  const { detection: d, org } = args;
  const plan: SetupPlan = { applied: [], suggestions: [], noted: [], kept: [], data: {} };
  if (!d.regularGame) return plan;

  const organiserSet = new Set(org.settingsSetByOrganiser);

  // Monthly list: noted, never applied. Seen with high confidence it
  // switches nothing on at all; otherwise it holds payment tracking off.
  const monthly = d.monthlyList.answer === "monthly_list" && d.monthlyList.confidence !== "low";
  // "Everything off" needs the CHAT to show it: a description that alone
  // claims a monthly list may be years old, and must not hold the chat's
  // own habits off.
  const monthlyInChat = d.monthlyList.evidence.length > (d.monthlyList.fromDescription?.length ?? 0);
  const monthlyHoldsAll = monthly && d.monthlyList.confidence === "high" && monthlyInChat;
  const paymentsProven = d.payments.answer === "players_confirm_paying" && proven(d.payments);
  if (monthly) {
    plan.noted.push({
      key: "monthlyList",
      prepayForMonth: d.monthlyList.prepayForMonth,
      payAsYouGoFillIns: d.monthlyList.payAsYouGoFillIns,
      creditForMissedGames: d.monthlyList.creditForMissedGames,
      confidence: d.monthlyList.confidence,
      evidence: d.monthlyList.evidence,
      ...source(d.monthlyList),
      heldPaymentTracking: paymentsProven,
    });
  }

  const candidates: Array<{ key: LearnedKey; to: SettingValue } & Evidenced> = [];
  const consider = (key: LearnedKey, to: SettingValue, a: { confidence: Confidence } & Evidenced) => {
    if (!shown(a)) return;
    if (!proven(a)) plan.kept.push({ key, reason: "thin-evidence" });
    else if (monthlyHoldsAll || (monthly && key === "paymentTracking")) plan.kept.push({ key, reason: "monthly-list" });
    else candidates.push({ key, to, evidence: a.evidence, ...source(a) });
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
    // `base` as the saved row: a time the club already has, saved under the
    // earlier allowed hours, does not get a newly learned one refused.
    const both = validateWeeklyDeadlines(withPair(publish, withPair(deadline, base)), args.activities, base);
    if (both) {
      let kept = base;
      for (const c of [deadline, publish]) {
        if (!c) continue;
        const err = validateWeeklyDeadlines(withPair(c, kept), args.activities, base);
        if (err) rejected.set(c.key, err);
        else kept = withPair(c, kept);
      }
    }
  }

  // Who fills an open place: asked, never switched (rule 4). It goes
  // last among the suggestions, which is where the DM shows it.
  const asked: Suggestion[] = [];
  for (const c of accepted) {
    const err = rejected.get(c.key);
    if (err) {
      plan.kept.push({ key: c.key, reason: `invalid:${err}` });
      continue;
    }
    if (SUGGEST_ONLY.has(c.key)) {
      asked.push({ key: "organiserPicks", current: String(currentValue(c.key, org)), detected: String(c.to), evidence: c.evidence, ...source(c) });
      continue;
    }
    plan.applied.push({ key: c.key, from: currentValue(c.key, org), to: c.to, evidence: c.evidence, ...source(c), undoneAt: null });
    Object.assign(plan.data, dataFor(c.key, c.to));
  }

  // The weekly game: suggestions only. The language is the organiser's
  // choice and is never guessed from the chat (2026-10-30).
  const g = args.weeklyGame;
  const w = d.weeklyGame;
  if (g && shown(w)) {
    if (w.day !== null && w.day !== g.dayOfWeek) {
      plan.suggestions.push({ key: "weeklyGameDay", current: String(g.dayOfWeek), detected: String(w.day), evidence: w.evidence, ...source(w) });
    }
    if (w.time !== null && w.time !== g.time) {
      plan.suggestions.push({ key: "weeklyGameTime", current: g.time, detected: w.time, evidence: w.evidence, ...source(w) });
    }
    if (w.venue && g.venue && !sameVenue(w.venue, g.venue)) {
      plan.suggestions.push({ key: "venue", current: g.venue, detected: w.venue, evidence: w.evidence, ...source(w) });
    }
    if (w.playersPerSide !== null && g.playersPerSide !== null && w.playersPerSide !== g.playersPerSide) {
      plan.suggestions.push({
        key: "format",
        current: String(g.playersPerSide),
        detected: String(w.playersPerSide),
        evidence: w.evidence,
        ...source(w),
      });
    }
  }

  // The match fee: asked, never set (rule 8). A quote from the description
  // is enough; from the chat alone it takes two messages.
  const f = d.matchFee;
  if (g && f.amount !== null && f.confidence !== "low" && !monthly && !org.monthlySquad && !g.feeSplitTotal) {
    const backed = (f.fromDescription?.length ?? 0) > 0 || f.evidence.length >= MIN_QUOTES_TO_APPLY;
    const now = g.feePerPlayer != null && g.feePerPlayer > 0 ? g.feePerPlayer : null;
    if (backed && (now === null || Math.abs(now - f.amount) >= 0.005)) {
      plan.suggestions.push({
        key: "matchFee",
        current: now === null ? "" : feeText(now),
        detected: feeText(f.amount),
        evidence: f.evidence,
        ...source(f),
      });
    }
  }
  plan.suggestions.push(...asked);
  return plan;
}

/** Does the plan give the organiser anything worth a DM? */
export function planIsWorthTelling(plan: SetupPlan): boolean {
  return plan.applied.length > 0 || plan.suggestions.length > 0 || plan.noted.length > 0;
}
