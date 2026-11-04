/**
 * THE SCHEDULED CHASE POST: CODE WRITES THE POST, THE MODEL WRITES ONE
 * LINE (2026-10-20). Pure: no database, no model call.
 *
 * The bot scheduler decides WHEN to chase (the 17:00 squad update, the
 * match-day morning, 3 to 4 hours before kickoff, about 2 hours before)
 * and `composeChaseFromMatch` (message-analyzer.ts) reads the squad and
 * calls the model. This file holds everything in between:
 *
 *   CHASE_LEAD_SYSTEM / chaseLeadUserTurn   the prompt: the model writes
 *                                           the opening line and nothing
 *                                           else, from facts code states;
 *   acceptChaseLead                         a line that breaks a fact
 *                                           (a number the squad does not
 *                                           hold, a list, a count that
 *                                           disagrees with the rows) is
 *                                           not posted;
 *   chaseFallbackLead                       the fixed line of each kind,
 *                                           used when the model is not;
 *   buildChaseRosterBlock                   the squad list: one row per
 *                                           place, a 🥁 for each open
 *                                           one, then the bench;
 *   chaseSwitchLine / assembleChasePost     the format-switch line and
 *                                           the post: lead, switch line,
 *                                           squad list.
 *
 * Before this the model wrote the whole post: a numbered roster with drum
 * rows, the bench block, the format-switch line copied verbatim and a
 * "tentative" line it had to guess, and the scheduler cut the roster back
 * out when the group had just seen it. Every number and name in the post
 * now comes from the rows.
 */
import { t } from "./i18n/t";
import { normaliseLang, type Lang } from "./i18n/lang";
import { longDayTimeLabel } from "./i18n/dates";
import { applyHouseStyle } from "./house-style";
import { computeProximity, enforceProximity, londonTimeLabel } from "./proximity";
import { buildFormatSwitchFacts, type SmallerFormat } from "./format-switch";
import { buildSlotRosterBlock, contradictsSquadState, displaysSquadState } from "./group-copy";
import type { NamedRow } from "./scheduler-copy";
import { placesOpen } from "./squad-short";

export type ChaseKind =
  | "daily-in-list" // the 17:00 squad update while places are open
  | "match-day-morning" // match day, morning
  | "chase-pre-kickoff" // 3 to 4 hours before kickoff
  | "pre-kickoff-short"; // about 2 hours before kickoff, places still open

/** What code knows about the post, and all the model is told. */
export interface ChaseFacts {
  kind: ChaseKind;
  lang: Lang;
  activityName: string;
  venue: string;
  kickoff: Date;
  now: Date;
  confirmed: number;
  maxPlayers: number;
  bench: number;
  /** `squadNumbers(...).short` (squad-short.ts): below the game's minimum.
   *  K1 (Kemal, 2026-11-04): at or above it the game is on, so the line
   *  says the places left, never "short". */
  short: boolean;
  /** `computeChaseRisk`'s verdict, daily post only. Never true unless
   *  `short` (K1). */
  atRisk: boolean;
}

/** The longest lead posted. A line, not a paragraph. */
export const MAX_LEAD_CHARS = 280;

export const CHASE_LEAD_SYSTEM = `You write the opening line of a post that MatchTime, the bot that runs a sports club's WhatsApp group, sends on a schedule while the next match still has places to fill. Under your line MatchTime adds the squad list itself, with the count and every name, so your line never lists players.

The context gives you the facts: the language, which post this is, the match, the kickoff, the squad, whether there are already enough players for the game to go ahead, and whether the match is at risk. Your line says where things stand and asks for what is needed, in the group's own casual voice. Keep it friendly and short, and word it a little differently each time.

The posts:
- daily: the regular squad update in the days before the match.
- match-day: the morning of the match day.
- before-kickoff: 3 to 4 hours before kickoff, a sharper call. Give the kickoff time.
- last-call: about 2 hours before kickoff, the last chance. Give the kickoff time and the venue.

Where the squad stands:
- "Enough to play: yes": the game is on. Ask for the open places as places left ("3 places left", "1 place left"), and never say the squad is short.
- "Enough to play: no": the squad is short. Say how many places are still to fill ("3 short", "3 more").
- "At risk: yes" (it only comes with "Enough to play: no"): push a bit harder and say once, plainly, that the game will have to be called off if we cannot find the numbers. That is the group's call, never yours: write "we'll have to call it off", never "I will cancel", and blame nobody. With "At risk: no", never mention calling the game off.

For every line:
- Every number and every day comes from the context; never work one out yourself. Say "tonight", "today" or "tomorrow" only when the kickoff line says today or tomorrow; otherwise name the day.
- Write the match's name exactly as the context gives it, or leave it out. Name no players.
- One or two sentences, under 200 characters. Bold is WhatsApp's *single asterisks*. One or two emoji at most.
- No greeting and no time of day ("Morning all", "Evening update"), and never the time the post is sent.
- No em dash and no en dash: use a comma, a colon or a full stop.
- Write in the context's language. In English, players join by saying *IN*. In Turkish, speak to the group in the plural, warm and informal (no "abi", no "beyler"); players join by writing *VARIM*.

Examples, with other facts (copy the shape, not the words):
Enough to play: no
daily, 3 places open, kickoff on Thursday:
  English: 🗓 *Thursday 6-a-side* needs *3 more* for Thursday. Say *IN* if you can play ⚽
  Turkish: 🗓 Perşembe *Halı Saha* için *3 kişi* daha lazım. Gelebilecekler *VARIM* yazsın ⚽
daily, at risk, 5 places open, kickoff tomorrow:
  English: ⚠️ Still *5 short* for tomorrow. If we can't get the numbers we'll have to call it off, so say *IN* if you can make it 🙏
  Turkish: ⚠️ Yarınki maç için hâlâ *5 kişi* eksiğiz. Sayıyı tamamlayamazsak maçı iptal etmek zorunda kalırız, gelebilen *VARIM* yazsın 🙏
last-call, 1 place open, kickoff 20:00 at Riverside:
  English: ⏰ *20:00* at *Riverside* and we're *1 short*. Last chance, say *IN* 🙏
  Turkish: ⏰ Maç *20:00*'de *Riverside*'da, *1 kişi* eksiğiz. Son şans, *VARIM* yazın 🙏
Enough to play: yes
daily, 2 places open, kickoff on Thursday:
  English: 🗓 *Thursday 6-a-side* is on for Thursday, *2 places left*. Say *IN* to grab one ⚽
  Turkish: 🗓 Perşembe *Halı Saha* maçı var, *2 kişilik yer* kaldı. Kapmak isteyen *VARIM* yazsın ⚽
last-call, 1 place open, kickoff 20:00 at Riverside:
  English: ⏰ *20:00* at *Riverside*, *1 place left*. Last chance to grab it, say *IN* 🙏
  Turkish: ⏰ Maç *20:00*'de *Riverside*'da, *1 kişilik yer* kaldı. Son şans, *VARIM* yazın 🙏

Return the line as "lead".`;

/** Structured output: the line, and nothing for a roster to hide in. */
export const CHASE_LEAD_SCHEMA = {
  type: "object",
  properties: { lead: { type: "string" } },
  required: ["lead"],
  additionalProperties: false,
} as const;

const POST_NAME: Record<ChaseKind, string> = {
  "daily-in-list": "daily",
  "match-day-morning": "match-day",
  "chase-pre-kickoff": "before-kickoff",
  "pre-kickoff-short": "last-call",
};

const LANGUAGE_NAME: Record<Lang, string> = { en: "English", tr: "Turkish" };

function need(f: ChaseFacts): number {
  return placesOpen(f.maxPlayers, f.confirmed);
}

/** The facts, one per line. The kickoff is written the way the group's
 *  language writes it, so the model copies a date it can use. */
export function chaseLeadUserTurn(f: ChaseFacts): string {
  const { daysOut } = computeProximity(f.kickoff, f.lang, f.now);
  const when = daysOut === 0 ? "today" : daysOut === 1 ? "tomorrow" : daysOut > 1 ? `in ${daysOut} days` : "already started";
  return [
    `Language: ${LANGUAGE_NAME[f.lang]}`,
    `Post: ${POST_NAME[f.kind]}`,
    `Match: ${f.activityName}, at ${f.venue}`,
    `Kickoff: ${longDayTimeLabel(f.lang, f.kickoff)} (${when})`,
    `Squad: ${f.confirmed} of ${f.maxPlayers} confirmed, ${need(f)} places open, ${f.bench} on the bench`,
    `Enough to play: ${f.short ? "no" : "yes"}`,
    `At risk: ${f.atRisk ? "yes" : "no"}`,
  ].join("\n");
}

/** The fixed lead of each kind: the copy the scheduler has always sent
 *  when the model was not available. At or above the game's minimum
 *  (K1, 2026-11-04) each kind says the places left instead. */
export function chaseFallbackLead(f: ChaseFacts): string {
  const s = t(f.lang);
  const timeLabel = londonTimeLabel(f.kickoff);
  const open = need(f);
  switch (f.kind) {
    case "daily-in-list":
      return f.short
        ? s.daily_in_list_fallback_lead({ activityName: f.activityName, need: open })
        : s.daily_in_list_places_left_lead({ activityName: f.activityName, open });
    case "match-day-morning":
      return f.short
        ? s.match_day_chase_fallback({ need: open, activityName: f.activityName })
        : s.match_day_chase_places_left({ open, activityName: f.activityName });
    case "chase-pre-kickoff":
      return f.short
        ? s.chase_pre_kickoff_fallback({ need: open, activityName: f.activityName, timeLabel })
        : s.chase_pre_kickoff_places_left({ open, activityName: f.activityName, timeLabel });
    case "pre-kickoff-short":
      return f.short
        ? s.pre_kickoff_short_fallback({ timeLabel, venue: f.venue, confirmed: f.confirmed, maxPlayers: f.maxPlayers, need: open })
        : s.pre_kickoff_places_left({ timeLabel, venue: f.venue, open });
  }
}

/** A lead that calls the squad short (K1: never at or above the game's
 *  minimum), and one that warns of a call-off (only when the server says
 *  the match is at risk). MatchTime's OWN line is checked here, never a
 *  player's message. */
const SAYS_SHORT: Record<Lang, RegExp> = {
  en: /\bshort\b/i,
  tr: /(?<!\p{L})eksi(?:ğiz|k|ğimiz)(?!\p{L})/iu,
};
const SAYS_CALL_OFF: Record<Lang, RegExp> = {
  en: /\bcall(?:ed|ing)?\s+(?:it|this|the\s+(?:match|game|fixture))\s+off\b|\bcancel\w*/i,
  tr: /iptal|ertele/iu,
};

/** Every number the lead may say: the counts, the kickoff's time and
 *  date, the days to go, and digits in the match's own name or venue. */
function allowedNumbers(f: ChaseFacts): Set<number> {
  const { daysOut } = computeProximity(f.kickoff, f.lang, f.now);
  const [hh, mm] = londonTimeLabel(f.kickoff).split(":").map(Number);
  const day = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric" }).format(f.kickoff));
  const out = new Set<number>([f.confirmed, f.maxPlayers, need(f), f.bench, hh, mm, day, daysOut]);
  for (const src of [f.activityName, f.venue]) for (const d of src.match(/\d+/g) ?? []) out.add(Number(d));
  return out;
}

/**
 * The model's lead, cleaned, or null when it must not be posted: empty,
 * longer than a line, a list, a count or move the rows do not back
 * (`contradictsSquadState`, the analyze path's guard), or any number the
 * facts do not hold. Cleaning is the house style (no dashes) and the
 * day words (`enforceProximity`).
 */
export function acceptChaseLead(raw: string, f: ChaseFacts): string | null {
  const lead = raw.trim();
  if (!lead || lead.length > MAX_LEAD_CHARS) return null;
  if (displaysSquadState(lead, f.lang) || /^\s*\d+[.)]\s+\S/m.test(lead)) return null;
  // Names never reach the model, so only the counts can be wrong here.
  const truth = {
    confirmed: Array.from({ length: f.confirmed }, (_, i) => `#${i}`),
    bench: Array.from({ length: f.bench }, (_, i) => `#b${i}`),
    maxPlayers: f.maxPlayers,
    knownNames: [],
  };
  if (contradictsSquadState(lead, truth, f.lang)) return null;
  if (!f.short && SAYS_SHORT[f.lang].test(lead)) return null;
  if (!f.atRisk && SAYS_CALL_OFF[f.lang].test(lead)) return null;
  const allowed = allowedNumbers(f);
  // A UTC slip ("20:30" for a 21:30 kickoff) is corrected, not rejected.
  const cleaned = applyHouseStyle(enforceProximity(lead, f.kickoff, f.lang, f.now), f.lang);
  for (const d of cleaned.match(/\d+/g) ?? []) if (!allowed.has(Number(d))) return null;
  return cleaned;
}

/** The server's format-switch line: when the squad is short (below the
 *  game's minimum, squad-short.ts; K1: at or above it the game is on),
 *  kickoff is within 24 hours and a smaller format would be filled. */
export function chaseSwitchLine(args: {
  confirmedNames: readonly string[];
  maxPlayers: number;
  /** `squadNumbers(...).short`. */
  short: boolean;
  alternatives: readonly SmallerFormat[];
  lang: Lang | string | null | undefined;
  hoursToKickoff: number;
}): string | null {
  if (args.hoursToKickoff > 24 || !args.short) return null;
  const facts = buildFormatSwitchFacts({
    confirmedNames: args.confirmedNames,
    currentMaxPlayers: args.maxPlayers,
    alternatives: args.alternatives,
    lang: normaliseLang(args.lang ?? null),
  });
  return facts.find((x) => x.proposal)?.proposal ?? null;
}

/**
 * The chase's squad list: the day header ("*Playing tonight:*", "*Playing
 * tomorrow:*", "*Playing Tue 8 Sept:*", the Turkish ones in Turkish),
 * the confirmed names, a 🥁 for every place still open, then the bench.
 * The open places are what a chase asks the group to fill, so each one is
 * shown (Kemal, 2026-10-20: the drum rows the old chase post had).
 * Only the chase: the other scheduled posts keep `buildSquadRosterBlock`.
 */
export function buildChaseRosterBlock(args: {
  confirmed: readonly NamedRow[];
  bench: readonly NamedRow[];
  maxPlayers: number;
  kickoff: Date;
  now: Date;
  lang: Lang | string | null | undefined;
}): string {
  const lang = normaliseLang(args.lang ?? null);
  const unnamed = t(lang).unnamed;
  const name = (r: NamedRow) => r.name ?? unnamed;
  return buildSlotRosterBlock({
    header: computeProximity(args.kickoff, lang, args.now).rosterHeader,
    confirmed: args.confirmed.map(name),
    bench: args.bench.map(name),
    maxPlayers: args.maxPlayers,
    lang,
  });
}

/** The post: the lead, the switch line, the squad list, a blank line apart. */
export function assembleChasePost(parts: { lead: string; switchLine: string | null; rosterBlock: string | null }): string {
  return [parts.lead, parts.switchLine, parts.rosterBlock].filter((p): p is string => !!p).join("\n\n");
}
