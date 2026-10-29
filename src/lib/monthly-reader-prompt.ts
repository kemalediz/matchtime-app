/**
 * THE MONTHLY READER'S PROMPT, SCHEMA AND ANSWER CHECK (2026-10-29). Pure:
 * no database and no model, so the unit tests and the live dry run
 * (scripts/dryrun-monthly-reader.ts) import exactly what production sends.
 *
 * A club that runs a month's list (Vets MNF) changes everything by
 * re-pasting a numbered list with notes beside the names ("smiler 4 only",
 * "Andrew (PAYG 5th only)", "Steff (paid pensioners rate)", "Jon extra"),
 * reusing old titles ("List for 12 October" pasted on 19 October), and by
 * plain sentences ("November good for me", "I'm in for November except
 * the last week"). People never keep to a format, so NOTHING here reads
 * the text with code (Kemal, 2026-10-29): the model reads the whole message
 * with the club's context (its members, its months, the week's list as
 * MatchTime has it, the recent chat, the message replied to) and returns
 * structured facts. Code only maps the member refs it was shown back to
 * ids and acts on the facts (`monthly-paste.ts`, `month-signup.ts`).
 *
 * Every answer is checked here: an unknown member ref is no member, a
 * number out of range is no number, and anything unreadable is "none",
 * which changes nothing.
 */
import type { SignupChoice } from "./month-signup-rules";
import type { MonthlyList, MonthlyListEntry, MonthlyListMarks, PaygDate } from "./monthly-list";
import { nowLine, quotedLines, type ContextMessage } from "./reply-context";

/** The header the message sits under in the user turn (the e2e stub reads it). */
export const MONTHLY_READER_MESSAGE_HEADER = "THE MESSAGE:";
/** How many lines of the recent chat are shown: the extractors' number. */
export const MONTHLY_READER_RECENT_LINES = 8;

export interface ReaderMember {
  /** The short ref the model is shown ("p1"). Never a database id. */
  ref: string;
  userId: string;
  name: string;
  aliases: string[];
  /** An owner or admin of the club. */
  organiser: boolean;
}

/** The club's context, loaded once per batch (`loadMonthlyReaderContext`). */
export interface MonthlyReaderContext {
  orgId: string;
  members: ReaderMember[];
  /** One block per live month: what it is, its games, and its list as
   *  MatchTime has it. Already written. */
  months: string[];
  /** The next game's list as MatchTime has it, with the game's date. Null
   *  when no week of a month is live. */
  week: { game: string; text: string } | null;
  /** A coming month can still be started from a list (no month for it
   *  yet). With no live month, no week and nothing to start, no message
   *  can act on anything monthly, and the reader is not asked. */
  seedable?: boolean;
}

export interface MonthlyReaderInput {
  body: string;
  sender: { userId: string | null; name: string | null; organiser: boolean };
  /** The recent chat, oldest first, the message itself excluded. */
  history: Array<{ author: string | null; body: string }>;
  /** The message this one replies to, when it is a reply. */
  reply: ContextMessage | null;
  now: Date;
}


export type MonthlyReading =
  | { kind: "none"; why: string }
  | {
      kind: "list";
      list: MonthlyList;
      /** The day of the month of the game the list is FOR, when it is a
       *  game's list (a stale title is read through). */
      gameDay: number | null;
      /** A week's list (who plays one game) or the month's (who is signed up). */
      listOf: "week" | "month";
      /** What the sender typed around the list, word for word. */
      residual: string;
    }
  | { kind: "signup"; choice: SignupChoice; month: number; days: number[]; games: number | null };

type ReaderEntry = MonthlyListEntry;

// ── The prompt ────────────────────────────────────────────────────────

export const MONTHLY_READER_SYSTEM = `You read one message from a football club's WhatsApp group for MatchTime, the club's bot. The club runs on a list for each month: regulars sign up and pay for the month, others pay as they go (PAYG) for single games, and each week they play from that list. People change it by copying the latest list, editing it and pasting it back, and they also just say things in the chat. They never keep to one format.

THE CONTEXT comes first, and it does most of the work:
- NOW, the date and time at the club.
- MEMBERS: everybody in the club, each with a ref (p1, p2 ...), any nicknames, and who is an organiser. Every name on a list is one of these people or somebody they brought.
- MONTHS: the months open or under way, their games, and each month's list as MatchTime has it.
- THE WEEK'S LIST: the next game's list as MatchTime has it.
- RECENT CHAT and the message replied to, if any.
Then THE MESSAGE and who sent it. Read it as a member of the group would, with all of that in mind. Messages are English or Turkish, often mixed, misspelt, with emoji.

kind: what THE MESSAGE is.
- "list": the club's list for a game or for a month, pasted or typed, even a short one ("List for November 1. Davide 2."). A numbered list of something else (kit, teams, votes, who owes money) is not.
- "signup": the sender joins a month, leaves it, or will play it pay-as-you-go, in any words: "IN FOR NOVEMBER", "November good for me", "I can play most weeks in November", "Kasım varım", "Kasım'da yokum", "PAYG for November 9th", or a bare "IN" replying to MatchTime's own month sign-up list. Not a sign-up: a plain "IN" or "out" for this week's game, a question, a maybe that depends on something ("if my knee is ok"), somebody else's plans.
- "none": anything else.

FOR A LIST.
- month: the month it is for (1 to 12); 0 when nothing says.
- listOf: "month" when it is the month's list (who is on the month: the sign-up list, its paid marks, MatchTime's own month or priced list, or somebody adding themselves to join the month), "week" when it is who plays one game (it follows THE WEEK'S LIST, names a game's date, or has edits for one game such as a blanked line or a name moved under can't play). During sign-up a list for the coming month is the month's list. In a month under way the group re-pastes "List for <month>" for each game: that is the week's list unless it is plainly the month's sign-up list again.
- gameDay: for a week's list, the day of the month of the game it is for; 0 otherwise. A group often re-pastes an old list under its old title for the next game ("List for 12 October" pasted on the 19th after "List for today?"): when the titled game is past, gameDay is the next game's day.
- residual: what the sender typed around the list in their own words, copied exactly ("can't make it lads"); "" when nothing. The title, part headers and MatchTime's own lines (places open, price, footer) are not residual.
- lines: every line of the list in order, blank numbered lines too. For each:
  section: "playing" for the main list; "cant_play" under a part like "Paid but can't play", "Can't play", "Out", "Injured", "Gelemeyenler", "Ödedi gelemiyor"; "reserves" under "Reserves", "Subs", "Yedekler"; "other" under any other part.
  slot: the number written; 0 when none. name: the person's name only, as written, without notes, brackets or emoji ("YorDan😁 (paid 22.50)" is "YorDan"); "" for a blank line.
  WHO IT IS. Match the name against MEMBERS: their name, first name, nickname, or an obvious spelling of one ("smiler" is the member known as Smiler; "Dan" is Jordan Daniels if he goes by Dan). Then member is that ref, and guest is false.
  If the name is NOBODY on MEMBERS, and not a nickname or spelling of one, it is a GUEST: guest is true and member is "". So is a line that says somebody is brought along ("Jon extra" is an extra player Jon brings, not Jon; "David (my son)"; "Ali'nin arkadaşı"); keep the name as written. host: the ref of who brought them, when the line or the chat says ("Jon extra" is Jon's); otherwise whoever added the line, which for a new line on THE MESSAGE is the sender ("sender"); "" only when you cannot tell. Only call a listed name a member when it really is one: two members it could be is member "" and guest false.
  games: the month's games the person commits to, when the line says ("4 only" is 4; "except the last week" of a five-game month is 4); 0 otherwise.
  payg: true for pay-per-game ("(PAYG)", "PAYG 5th only"); paygDays: the days named for it ([5] for "5th only"), else [].
  paid: true when the line says they have paid ("paid", "(Paid £22.50)", "ödedi"; "not paid" is false); paidPence: the amount with it in pence (2250), else 0.
  concession: true for a reduced rate ("pensioners rate", "OAP", "emekli"). newbie: true when it says they are new ("newbie", "first time", "yeni").

FOR A SIGN-UP. choice: "in" (a regular for the month), "out" (not playing the month), "payg" (single games). signupMonth: the month (1 to 12), from the message, the chat or the list it replies to. days: the days named for PAYG. games: the games committed when fewer than all ("except the last week" of five is 4), else 0.

Fields that do not apply: "", 0, false or [].

Examples (English | Turkish):
- "List for November\\n1. Davide\\n7. smiler 4 only" | "Kasım listesi\\n1. Erdal\\n2. Mehmet sadece 3 hafta": list, month 11, listOf month; smiler is the member Smiler, games 4 | Mehmet games 3.
- "8. Andrew (PAYG 5th only)\\n4. Steff (paid pensioners rate)" | "8. Burak (PAYG sadece 9'u)\\n4. Kemal (ödedi emekli)": Andrew payg, paygDays [5]; Steff paid, concession | Burak payg [9]; Kemal paid, concession.
- From Dean, "15. David (PAYG)\\n16. Luca" with a David among the members and no Luca | "16. Can" with no Can: David is that member; Luca is a guest, host "sender" | Can a guest, host "sender".
- "13. Jon extra" | "13. Emre'nin oğlu Can": a guest, host Jon's ref | a guest, host Emre's ref.
- "Paid but can't play\\n1. Serg" | "Ödedi gelemiyor\\n1. Volkan": section cant_play.
- "List for 12 October" re-pasted on 19 October, the 12th played | "12 Ekim listesi" 19 Ekim'de: listOf week, gameDay 19.
- "November good for me", "I'm in for November except the last week" | "Kasım bana uyar", "Kasım varım son hafta hariç": signup in, month 11; games 4 for the second when November has five games.
- "Are we off tonight?" | "bu akşam maç var mı?": none.

Output STRICT JSON only, no markdown, no fences.`;

const LINE_SCHEMA = {
  type: "object",
  properties: {
    section: { type: "string", enum: ["playing", "cant_play", "reserves", "other"] },
    slot: { type: "integer" },
    name: { type: "string" },
    member: { type: "string" },
    guest: { type: "boolean" },
    host: { type: "string" },
    games: { type: "integer" },
    payg: { type: "boolean" },
    paygDays: { type: "array", items: { type: "integer" } },
    paid: { type: "boolean" },
    paidPence: { type: "integer" },
    concession: { type: "boolean" },
    newbie: { type: "boolean" },
  },
  required: ["section", "slot", "name", "member", "guest", "host", "games", "payg", "paygDays", "paid", "paidPence", "concession", "newbie"],
  additionalProperties: false,
} as const;

/** Structured output. No nullable types: the API rejects them, so "", 0,
 *  false and [] mean "not so" (the extractors' convention). */
export const MONTHLY_READER_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["list", "signup", "none"] },
    month: { type: "integer" },
    gameDay: { type: "integer" },
    listOf: { type: "string", enum: ["week", "month", ""] },
    lines: { type: "array", items: LINE_SCHEMA },
    residual: { type: "string" },
    choice: { type: "string", enum: ["in", "out", "payg", ""] },
    signupMonth: { type: "integer" },
    days: { type: "array", items: { type: "integer" } },
    games: { type: "integer" },
  },
  required: ["kind", "month", "gameDay", "listOf", "lines", "residual", "choice", "signupMonth", "days", "games"],
  additionalProperties: false,
} as const;

// ── The user turn ─────────────────────────────────────────────────────

function memberLine(m: ReaderMember): string {
  const aka = m.aliases.filter((a) => a && a.toLowerCase() !== m.name.toLowerCase());
  return `  ${m.ref}: ${m.name}${aka.length > 0 ? ` (also: ${aka.join(", ")})` : ""}${m.organiser ? ", organiser" : ""}`;
}

/** PURE. The context first, then the message. */
export function buildMonthlyReaderUserTurn(input: MonthlyReaderInput, ctx: MonthlyReaderContext): string {
  const senderRef = input.sender.userId ? ctx.members.find((m) => m.userId === input.sender.userId)?.ref : undefined;
  const lines: string[] = [nowLine(input.now), "", "MEMBERS:", ...ctx.members.map(memberLine), ""];
  if (ctx.months.length > 0) lines.push("MONTHS:", ...ctx.months, "");
  if (ctx.week) lines.push(`THE WEEK'S LIST AS MATCHTIME HAS IT (next game: ${ctx.week.game}):`, ctx.week.text, "");
  const recent = input.history.filter((h) => !(h.body === input.body)).slice(-MONTHLY_READER_RECENT_LINES);
  if (recent.length > 0) {
    lines.push("RECENT CHAT (context only):");
    for (const h of recent) lines.push(`  ${h.author ?? "(unknown)"}: ${h.body}`);
    lines.push("");
  }
  if (input.reply) lines.push(...quotedLines(input.reply), "");
  const who = senderRef
    ? `${input.sender.name ?? "a member"} (${senderRef}${input.sender.organiser ? ", an organiser" : ""})`
    : `${input.sender.name ?? "somebody"} (not on the MEMBERS list)`;
  lines.push(`From ${who}.`, MONTHLY_READER_MESSAGE_HEADER, input.body.trim());
  return lines.join("\n");
}

// ── The answer, checked ───────────────────────────────────────────────

const NONE = (why: string): MonthlyReading => ({ kind: "none", why });

const int = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const bool = (v: unknown): boolean => v === true;

/** Collapse spacing and case for the "is it in the message?" check. */
const fold = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ​-‏⁠﻿]/g, "").toLocaleLowerCase("tr").replace(/\s+/g, " ").trim();

/**
 * PURE. The model's JSON, checked against the context it was given. Never
 * throws: anything it cannot trust is left out, and an unreadable answer
 * is "none".
 */
export function parseMonthlyReading(raw: unknown, input: MonthlyReaderInput, ctx: MonthlyReaderContext): MonthlyReading {
  if (!raw || typeof raw !== "object") return NONE("not an object");
  const o = raw as Record<string, unknown>;
  const byRef = new Map(ctx.members.map((m) => [m.ref, m.userId]));
  const refOf = (v: unknown): string | null => {
    const r = str(v);
    if (r === "sender") return input.sender.userId;
    return byRef.get(r) ?? null;
  };

  if (o.kind === "signup") {
    const choice = o.choice === "in" || o.choice === "out" || o.choice === "payg" ? o.choice : null;
    const month = int(o.signupMonth, 1, 12);
    if (!choice || !month) return NONE("signup without a choice or a month");
    const days = Array.isArray(o.days) ? [...new Set(o.days.map((d) => int(d, 1, 31)).filter((d): d is number => d !== null))] : [];
    return { kind: "signup", choice, month, days: choice === "payg" ? days : [], games: int(o.games, 1, 31) };
  }
  if (o.kind !== "list") return NONE(o.kind === "none" ? "none" : "no valid kind");

  const rawLines = Array.isArray(o.lines) ? o.lines : [];
  const listMonth = int(o.month, 1, 12);
  const slots: ReaderEntry[] = [];
  const cantPlay: ReaderEntry[] = [];
  const reserves: ReaderEntry[] = [];
  const other: ReaderEntry[] = [];
  for (const l of rawLines) {
    if (!l || typeof l !== "object") continue;
    const x = l as Record<string, unknown>;
    const name = str(x.name).slice(0, 60);
    const paygDays: PaygDate[] = Array.isArray(x.paygDays)
      ? [...new Set(x.paygDays.map((d) => int(d, 1, 31)).filter((d): d is number => d !== null))].map((day) => ({ day, month: listMonth }))
      : [];
    const payg = bool(x.payg);
    const paid = bool(x.paid);
    const marks: MonthlyListMarks = {
      paid,
      paidAmountPence: paid ? int(x.paidPence, 1, 100_000) : null,
      tier: bool(x.concession) ? "concession" : null,
      payg,
      paygDates: payg ? paygDays : [],
    };
    const games = name ? int(x.games, 1, 31) : null;
    marks.gamesCommitted = games;
    const memberId = name ? refOf(x.member) : null;
    // A line the reader matched to a member is that member, never a guest
    // (review of #465): the month's own rules then decide who may add him.
    const guest = !!name && bool(x.guest) && memberId === null;
    const entry: ReaderEntry = {
      slot: int(x.slot, 1, 99),
      raw: name,
      name,
      marks,
      facts: {
        memberId,
        guest,
        hostUserId: guest ? refOf(x.host) : null,
        games,
        newbie: bool(x.newbie),
      },
    };
    const section = x.section;
    if (section === "cant_play") cantPlay.push(entry);
    else if (section === "reserves") reserves.push(entry);
    else if (section === "other") other.push(entry);
    else slots.push(entry);
  }
  if (slots.length + cantPlay.length + reserves.length + other.length === 0) return NONE("a list with no lines");

  // The residual goes on to the rest of the pipeline. It must be words of
  // the message itself: anything else is dropped, never passed on.
  const residualRaw = str(o.residual);
  const residual = residualRaw && fold(input.body).includes(fold(residualRaw)) ? residualRaw : "";
  if (residualRaw && !residual) console.warn("[monthly-reader] residual not found in the message; dropped");

  return {
    kind: "list",
    list: { month: listMonth ? { month: listMonth, year: null } : null, slots, sections: { cantPlay, reserves, other } },
    gameDay: int(o.gameDay, 1, 31),
    listOf: o.listOf === "month" ? "month" : "week",
    residual,
  };
}
