/**
 * PURE group-post copy. No database, no model, no clock.
 *
 * Both functions here were already pure and already correct; they were
 * simply living in files that import the Prisma client
 * (`message-analyzer.ts` → `./db`, `team-generation.ts` → `./db`), which
 * makes them unreachable from anywhere that must not load Prisma — the
 * Playwright worker process being the one that matters right now
 * (`e2e/sim/group.ts`: "plain SQL via the pg helper — no Prisma in the
 * Playwright process").
 *
 * Moved VERBATIM. Both original modules re-export them, so every
 * existing import keeps working and no call site changed. §13 lists
 * `composeSquadStatusPost()` under "what must not change": *"Already
 * correct. Promoted, not rewritten."* This is the promotion, and the
 * byte-stability the sim suite asserts on is preserved.
 *
 * LANGUAGE (2026-09-17, Phase 2 of MDs/multi-language-design-2026-09-16.md):
 * every builder here takes an optional `lang` and reads its words from
 * `t(lang)` (`src/lib/i18n/`). English is the default and the English
 * bytes are unchanged, which `src/lib/i18n/__tests__/copy-golden.test.ts`
 * proves. A composer that has not been given a language speaks English.
 */
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";

/**
 * Deterministic, server-composed squad+bench status post. Used for EVERY
 * squad-state reply (§10 step 4, 2026-09-01; before that, only when a
 * batch produced multiple of them). Computed from a FRESH DB snapshot
 * taken AFTER every attendance write in the batch has been applied — so
 * it can never contradict itself or the database (Kemal's chosen design,
 * 2026-06-12: "examine all messages in the window as a whole, then post
 * ONE clear message with the latest squad and bench").
 */
export function composeSquadStatusPost(args: {
  confirmed: string[];
  bench: string[];
  maxPlayers: number;
  lang?: Lang | string | null;
}): string {
  const { confirmed, bench, maxPlayers } = args;
  const s = t(args.lang);
  const need = Math.max(0, maxPlayers - confirmed.length);
  const lead = s.squad_status_lead({
    withBench: bench.length > 0,
    confirmed: confirmed.length,
    maxPlayers,
    need,
  });
  const rows: string[] = [];
  for (let i = 0; i < maxPlayers; i++) {
    rows.push(i < confirmed.length ? `${i + 1}. ${confirmed[i]}` : `${i + 1}. 🥁`);
  }
  const lines = [lead, "", s.playing_header, ...rows];
  if (bench.length > 0) {
    lines.push("", s.bench_header({ count: bench.length }));
    bench.forEach((n, i) => lines.push(`${i + 1}. ${n}`));
  }
  return lines.join("\n");
}

/**
 * Pure formatter for the group "teams" post. Single source of truth for
 * the message layout, shared by `generateTeamsForMatch` (after balancing)
 * and the analyze route's "show the teams again" re-post path (which
 * reads the EXISTING assignments verbatim — no balancer). Keep the output
 * byte-stable: the sim suite asserts on its substrings.
 */
export function formatTeamsPost(args: {
  redLabel: string;
  yellowLabel: string;
  red: { name: string }[];
  yellow: { name: string }[];
  kickoff: string;
  venue: string;
  lang?: Lang | string | null;
}): string {
  const s = t(args.lang);
  const listFor = (arr: { name: string }[]) =>
    arr.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
  return (
    `${s.teams_post_header({ kickoff: args.kickoff, venue: args.venue })}\n\n` +
    `*${args.redLabel}*:\n${listFor(args.red)}\n\n` +
    `*${args.yellowLabel}*:\n${listFor(args.yellow)}\n\n` +
    s.teams_post_footer
  );
}

/**
 * Row 43: the "Squad complete" post, the moment the confirmed count
 * reaches the cap. Extracted VERBATIM from `squad-announce.ts` on
 * 2026-09-17 so the golden snapshot can pin its bytes; that module still
 * owns the atomic claim and the `BotJob`, this owns only the words.
 *
 * `kickoffLabel` is the London day-and-time label the caller formats
 * ("Tue 22 Sept 21:30"); `benchInvite` is `buildSquadCompleteBenchInvite()`
 * when the org's bench feature is on, else null (same message, never a
 * second post: Kemal 2026-09-16). Names may be missing on a row and are
 * printed as "(unnamed)", exactly as before.
 */
export function buildSquadCompletePost(args: {
  maxPlayers: number;
  activityName: string;
  kickoffLabel: string;
  confirmed: Array<string | null>;
  bench: Array<string | null>;
  benchInvite: string | null;
  lang?: Lang | string | null;
}): string {
  const s = t(args.lang);
  const roster = args.confirmed.map((n, i) => `${i + 1}. ${n ?? s.unnamed}`).join("\n");
  // Bench shown in EVERY squad display, all orgs (Kemal 2026-06-12): a
  // benched player scanning the "squad complete" post must see their
  // name rather than wonder if they were dropped.
  const benchBlock =
    args.bench.length > 0
      ? `\n\n${s.bench_header({ count: args.bench.length })}\n${args.bench
          .map((n, i) => `${i + 1}. ${n ?? s.unnamed}`)
          .join("\n")}`
      : "";
  const invite = args.benchInvite ? `\n\n${args.benchInvite}` : "";
  return (
    `${s.squad_complete_header({ maxPlayers: args.maxPlayers, activityName: args.activityName, kickoffLabel: args.kickoffLabel })}\n\n` +
    `${s.playing_header}\n${roster}${benchBlock}\n\n${s.squad_complete_signoff}${invite}`
  );
}

// ── §10 step 4 — COMPOSITION ───────────────────────────────────────────
//
// "Every outgoing message is composed from the database AFTER the writes
// land. `composeSquadStatusPost()` is the model; generalise it. Numbers
// and names are never model-authored, so they cannot be wrong, so
// nothing needs to check them afterwards" (§6.4).
//
// What follows is the trigger and the rule. It replaces five regex
// post-processors that each patched the model's words after it had
// already written the wrong ones:
//
//   enforceCanonicalRoster        message-analyzer.ts, 140 lines
//   rewriteOverconfidentPromotion message-analyzer.ts
//   the promotion strip inside it, and the offer-independent one in
//                                 the analyze route
//   the squad-status collapse     the analyze route
//
// None of them could do anything about a lie in a shape they did not
// match. Composition does not match shapes: whatever the model wrote
// about the squad is DISCARDED and the post is built from the rows.

/** The token the analyzer prompt asks the model to emit where a roster
 *  would have gone. The model no longer writes rosters, counts or bench
 *  lists; it writes the human half and marks the spot. Detection does
 *  NOT depend on it — a disobedient model that writes a roster anyway is
 *  caught by `displaysSquadState` — so this is an optimisation (fewer
 *  output tokens), never a load-bearing contract. */
export const SQUAD_POST_MARKER = "[SQUAD]";

const SQUAD_POST_MARKER_RE = /\[SQUAD\]/gi;

export interface SquadTruth {
  /** CONFIRMED rows, in position order, as the database has them. */
  confirmed: string[];
  /** BENCH rows, in position order. */
  bench: string[];
  maxPlayers: number;
  /** Every name the group knows — active members plus anyone on this
   *  match. Used ONLY to decide whether a capitalised word in the reply
   *  is a person, so that "adding Tuesday to the calendar" is not read
   *  as registering a player called Tuesday. The corpus grader applies
   *  the same restriction ("only judge claims about people this world
   *  knows about"). */
  knownNames?: string[];
}

/** Leaderboard rows also use "N. <name>" numbering but carry stats
 *  markers ("— 4/4 (100%)", "— 2 wins", "— 1042", percent signs,
 *  "votes"). A stats answer is never squad state and must never be
 *  replaced by a squad post (Kemal flagged 2026-05-14 when "top 3 most
 *  consistent" turned into the upcoming squad list). */
function isLeaderboardLine(s: string): boolean {
  return (
    /\s—\s/.test(s) || // em-dash separator the leaderboard formatter uses
    /\d+\s*%/.test(s) || // "(96%)"
    /\b(?:wins?|votes?|matches?)\b/i.test(s) || // "2 wins", "5 of 11 votes"
    /\b\d+\/\d+\s*\(/.test(s) // "4/4 (100%)" — attendance pattern
  );
}

/**
 * Does this reply DISPLAY squad state — a numbered roster, a squad/bench
 * header, an "N/M" count claim, or a bench-emptiness claim?
 *
 * Moved from `message-analyzer.ts` (`looksLikeSquadStateReply`) with its
 * rules unchanged. Its job changed, though: it used to select the
 * replies that collapse into one post when there were two or more, and
 * now it selects the replies that are composed from the database — of
 * which there is at most one per batch either way.
 */
export function displaysSquadState(text: string): boolean {
  const lines = text.split("\n");
  // Stats/leaderboard replies — never squad state, never composed over.
  if (lines.some((l) => /^\s*\d+\.\s+\S/.test(l) && isLeaderboardLine(l))) {
    return false;
  }
  // (a) A numbered roster run of 2+ lines.
  let run = 0;
  for (const l of lines) {
    if (/^\s*\d+\.\s+\S/.test(l)) {
      run++;
      if (run >= 2) return true;
    } else {
      run = 0;
    }
  }
  // (b) Squad/bench display headers.
  if (
    /\*(?:Playing\b[^*\n]*|Squad\b[^*\n]*|Confirmed\s*\(\d+\/\d+\)[^*\n]*|Bench\s*\(\d+\)[^*\n]*):?\*/i.test(
      text,
    )
  ) {
    return true;
  }
  // (c) A count claim alongside squad vocabulary.
  if (/\b\d+\/\d+\b/.test(text) && /\b(?:squad|bench|slot|full|need|player)/i.test(text)) {
    return true;
  }
  if (/\bbench is empty\b/i.test(text)) return true;
  return false;
}

type ClaimedStatus = "CONFIRMED" | "BENCH" | "DROPPED";

/** A capitalised word followed by letters: the thing a move claim names.
 *  `\p{Lu}`, not `[A-Z]` (fixed 2026-09-16): the patterns below run
 *  with the `i` flag, so `[A-Z]` matched any ASCII letter but never Ç,
 *  Ğ, İ, Ö, Ş or Ü. "Çağrı goes on the bench" captured "ağrı", which
 *  matches nobody, and the guard was blind to the sentence. Pinned in
 *  `__tests__/unicode-names.test.ts`; ASCII verdicts are unchanged. */
const CLAIM_NAME = "(\\p{Lu}[\\p{L}'-]+)";
const TO_BENCH = "(?:on|onto|to)?\\s*(?:the\\s+)?bench";

/**
 * Announcements of a move, as text shapes. The first seven mirror the
 * corpus grader's `claimedMoves` (`e2e/corpus/grade.ts`) — deliberately,
 * so the property the corpus judges ("never announce a move the database
 * did not make", S7/Erdal, `bef5252`) is the property enforced here —
 * with the verbs made case-insensitive, which the grader's are not. The
 * rest are the promotion phrasings `rewriteOverconfidentPromotion` used
 * to strip after the fact (Sutton, 2026-05-18 and 2026-05-26).
 */
const MOVE_CLAIM_PATTERNS: Array<[RegExp, ClaimedStatus]> = [
  [
    new RegExp(`${CLAIM_NAME}\\s+(?:goes|go|is going|will go|moves|drops)\\s+${TO_BENCH}`, "giu"),
    "BENCH",
  ],
  [new RegExp(`${CLAIM_NAME}\\s+is\\s+(?:now\\s+)?on\\s+the\\s+bench`, "giu"), "BENCH"],
  [new RegExp(`(?:moving|putting|benching|demoting)\\s+${CLAIM_NAME}\\b`, "giu"), "BENCH"],
  [new RegExp(`${CLAIM_NAME}\\s+is\\s+(?:now\\s+)?(?:in|confirmed|playing)\\b`, "giu"), "CONFIRMED"],
  [new RegExp(`(?:adding|added|registering|registered)\\s+${CLAIM_NAME}\\b`, "giu"), "CONFIRMED"],
  [new RegExp(`${CLAIM_NAME}\\s+is\\s+(?:now\\s+)?out\\b`, "giu"), "DROPPED"],
  [new RegExp(`(?:dropping|dropped|marking)\\s+${CLAIM_NAME}\\s+(?:as\\s+)?out\\b`, "giu"), "DROPPED"],
  // Promotion phrasings — a claim that a bench player now has a slot.
  [new RegExp(`${CLAIM_NAME}\\s+(?:moves?|comes?|steps?)\\s+(?:up|in)\\b`, "giu"), "CONFIRMED"],
  [new RegExp(`${CLAIM_NAME}\\s+(?:stepped|stepping)\\s+in\\b`, "giu"), "CONFIRMED"],
  [new RegExp(`${CLAIM_NAME}\\s+is\\s+replacing\\b`, "giu"), "CONFIRMED"],
  [new RegExp(`${CLAIM_NAME}\\s+is\\s+promoted\\b`, "giu"), "CONFIRMED"],
  [new RegExp(`(?:promoting|promoted)\\s+${CLAIM_NAME}\\b`, "giu"), "CONFIRMED"],
];

/** Which row does the database have for the person this claim names?
 *  `null` when the claim is not about anyone the group knows.
 *  A single token matches any part of a full name: the model writes
 *  "Greg", "Gale" and "Greg Gale" for the same person, and the pattern
 *  that spotted the claim only ever captures one token. */
function statusOfClaimedName(name: string, truth: SquadTruth): ClaimedStatus | null {
  const known = truth.knownNames ?? [...truth.confirmed, ...truth.bench];
  const lower = name.toLowerCase();
  const match = known.find(
    (n) =>
      n.toLowerCase() === lower ||
      n
        .trim()
        .split(/\s+/)
        .some((part) => part.length >= 3 && part.toLowerCase() === lower),
  );
  if (!match) return null;
  const inList = (list: string[]) => list.some((n) => n.toLowerCase() === match.toLowerCase());
  if (inList(truth.confirmed)) return "CONFIRMED";
  if (inList(truth.bench)) return "BENCH";
  return "DROPPED"; // no row (or a dropped one) — either way, not playing.
}

/**
 * Does this reply assert something about the squad that the database
 * does not support — a move nobody made, a count that is not the count,
 * a "need N more" that is not what is needed?
 *
 * This is the S7 property (Erdal, `bef5252`, 2026-05-15: the bot
 * announced "Erdal goes on the bench" with no write behind it) turned
 * into a trigger. It never edits the sentence; it decides that the
 * database, not the model, gets to describe the squad.
 */
export function contradictsSquadState(text: string, truth: SquadTruth): boolean {
  // A stats answer's numbers are not squad claims. "Kemal — 4/14 (29%)"
  // is an attendance record, and on a 14-a-side match the count check
  // below would read it as a squad count that disagrees with the rows —
  // and then replace a leaderboard with a squad post, which is a worse
  // version of the 2026-05-14 bug this whole exclusion exists for.
  // Move claims are still judged: they are about a named person's row
  // and mean the same thing wherever they appear.
  const isStatsAnswer = text
    .split("\n")
    .some((l) => /^\s*\d+\.\s+\S/.test(l) && isLeaderboardLine(l));

  for (const [re, claimed] of MOVE_CLAIM_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const name = m[1];
      if (!name) continue;
      const actual = statusOfClaimedName(name, truth);
      if (actual === null) continue; // not a person this group knows
      if (actual !== claimed) return true;
    }
  }
  if (isStatsAnswer) return false;
  // A count against this match's capacity, e.g. "we're still 13/14".
  const countRe = new RegExp(`\\b(\\d+)\\s*/\\s*${truth.maxPlayers}\\b`, "g");
  for (const m of text.matchAll(countRe)) {
    if (Number(m[1]) !== truth.confirmed.length) return true;
  }
  // "need 2 more" / "need *2 more*" against the real shortfall.
  const need = Math.max(0, truth.maxPlayers - truth.confirmed.length);
  const needRe = /\bneed\s+\*?\s*(\d+|one|two|three|four|five)\s*\*?\s+more\b/gi;
  const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  for (const m of text.matchAll(needRe)) {
    const raw = m[1].toLowerCase();
    const n = WORDS[raw] ?? Number(raw);
    if (n !== need) return true;
  }
  // Slot prose against the same shortfall (RC3 of 2026-06-12: the count
  // was patched to "14/14" and "— one slot open" survived next to it).
  if (need > 0) {
    if (
      /\b(?:full\s+squad|squad\s+(?:is\s+)?(?:now\s+)?(?:complete|full|locked)|we'?re\s+(?:now\s+)?full)\b/i.test(
        text,
      )
    ) {
      return true;
    }
  }
  const slotRe = /\b(one|a|an|two|three|\d+)\s+(?:more\s+)?slots?\s+(?:still\s+)?open\b/gi;
  for (const m of text.matchAll(slotRe)) {
    const raw = m[1].toLowerCase();
    const n = raw === "a" || raw === "an" ? 1 : (WORDS[raw] ?? Number(raw));
    if (n !== need) return true;
  }
  // A total that cannot be true — "15 players" on a 14-player match.
  // The old cap rewrote these numbers in place; the composer replaces
  // the whole reply, so it asks for squad vocabulary too: "covered 6
  // players" in a payment ack is not a claim about the squad.
  if (/\b(?:squad|playing|turnout|confirmed|bench|lineup)\b/i.test(text)) {
    for (const m of text.matchAll(/\b(\d+)\s+(?:players?|total)\b/gi)) {
      if (Number(m[1]) > truth.maxPlayers) return true;
    }
  }
  return false;
}

/** Did the model ask for the squad post to be appended here? */
export function wantsSquadPost(text: string): boolean {
  SQUAD_POST_MARKER_RE.lastIndex = 0;
  return SQUAD_POST_MARKER_RE.test(text);
}

/**
 * Last-mile cleanup: the marker must never be posted to a group.
 * `composeSquadStateReply` removes it on every path it takes, but it
 * only runs when there is a match to compose from. Ask "who's playing?"
 * in a group with no upcoming match and the model still emits the
 * marker it was told to emit, and without this the group would read a
 * literal "[SQUAD]".
 *
 * Returns "" when the marker was the whole reply — the caller then says
 * nothing rather than sending an empty message.
 */
export function stripSquadPostMarker(text: string): string {
  if (!wantsSquadPost(text)) return text;
  return text.replace(SQUAD_POST_MARKER_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * THE RULE. Given the model's reply and the database's truth, return the
 * text the group actually gets.
 *
 *   - A reply that neither shows squad state nor contradicts it, and did
 *     not ask for a squad post, is returned untouched. MatchTime's acks,
 *     answers and banter are not this function's business.
 *   - Otherwise the squad post is composed from `truth`, and everything
 *     the model wrote about the squad is dropped — not patched, dropped.
 *   - The model's LEAD survives (the reason someone is out, the ask, the
 *     server-computed format-switch line) but only while it makes no
 *     claim of its own. A lead that states a count would put two counts
 *     one line apart, which is RC1 of the 2026-06-12 incident.
 *
 * `composed: true` means the group is getting the database's words. The
 * analyze route uses it to keep exactly one such post per batch.
 */
export function composeSquadStateReply(
  reply: string,
  truth: SquadTruth,
  lang?: Lang | string | null,
): { text: string; composed: boolean } {
  const wanted = wantsSquadPost(reply);
  const lead = wanted ? reply.replace(SQUAD_POST_MARKER_RE, "").trim() : reply;
  if (!wanted && !displaysSquadState(reply) && !contradictsSquadState(reply, truth)) {
    return { text: reply, composed: false };
  }
  const post = composeSquadStatusPost({
    confirmed: truth.confirmed,
    bench: truth.bench,
    maxPlayers: truth.maxPlayers,
    lang,
  });
  const keepLead =
    wanted && lead.length > 0 && !displaysSquadState(lead) && !contradictsSquadState(lead, truth);
  return { text: keepLead ? `${lead}\n\n${post}` : post, composed: true };
}

/**
 * ── No time of day in a scheduled post ─────────────────────────────
 *
 * The two builders below are the static group posts that used to open
 * with "Morning all". They no longer open with any time of day, and
 * nothing that fires on a schedule should.
 *
 * Why: the scheduler decides WHEN a post is due, but the Pi decides when
 * it actually goes out. A released claim, a rate-limited DM queue or a
 * bot coming back from an outage can push a post hours past its window
 * — on 2026-09-16 the rating promo opened "🎯 Morning all" at 16:05
 * London because the rating claims were re-issued after an outage. A
 * greeting that is right 95% of the time and wrong the other 5% is
 * worse than no greeting: the 5% is what the group screenshots. Kemal's
 * standing rule from the 2026-09-04 "Quick 5pm update" incident is the
 * short version — "we don't need the time on the updates".
 *
 * The fix is to drop the time, not to compute it. A clock-aware
 * greeting would be correct more often and would still be a thing that
 * can be wrong, for no gain: nobody needs to be told what part of the
 * day it is.
 */

/**
 * The group post that follows the rating DMs.
 *
 * Fires on the first tick after the LAST rating DM has landed, which is
 * any hour from 08:00 London onward on a day after the match (the window
 * is 6-36h past kickoff). The match is therefore named by its DATE, not
 * as "last night's": a Saturday lunchtime kickoff gets this post on
 * Sunday morning, when "last night" is simply false.
 *
 * `matchDateLabel` is the London-formatted match date, e.g. "Tue 15 Sep"
 * — the same `EEE d MMM` label the rating DM itself uses.
 */
export function buildRatePromoPost(args: {
  activityName: string;
  matchDateLabel: string;
  lang?: Lang | string | null;
}): string {
  return t(args.lang).rate_promo({ activityName: args.activityName, matchDateLabel: args.matchDateLabel });
}

/**
 * Static fallback for the match-day chase (the one scheduled for the
 * 8-9am London window) when the model compose path is unavailable.
 * Keeps the sun emoji and the ask; drops the "Morning all" greeting.
 */
export function buildMatchDayChaseFallback(args: {
  need: number;
  activityName: string;
  lang?: Lang | string | null;
}): string {
  return t(args.lang).match_day_chase_fallback({ need: args.need, activityName: args.activityName });
}

// ── Extracted verbatim on 2026-09-17 (Phase 2 slice 2) so the golden ──
// snapshot can pin them; the owning modules keep the database work.

/** Row 64: the admin "switch format" announcement (`app/actions/matches.ts`).
 *  `kickoffLine` is `renderKickoffMoveLine`'s output ("" when the kickoff
 *  did not move); names missing on a row print as "?", as they always did. */
export function buildFormatSwitchAnnouncement(args: {
  sportName: string;
  maxPlayers: number;
  kickoffLine: string;
  playing: Array<string | null>;
  bench: Array<string | null>;
}): string {
  const playerLines = args.playing.map((n, i) => `${i + 1}. ${n ?? "?"}`).join("\n");
  const benchLines = args.bench.length
    ? "\n\n*Bench:*\n" + args.bench.map((n, i) => `${i + 1}. ${n ?? "?"}`).join("\n")
    : "";
  return (
    `🔁 *Match switched* — now *${args.sportName}* (${args.maxPlayers} players).\n` +
    (args.kickoffLine ? `${args.kickoffLine}\n` : "") +
    `\n*Playing (${args.playing.length}/${args.maxPlayers}):*\n${playerLines || "_nobody yet_"}` +
    benchLines
  );
}

/** Row 65: the admin "cancel match" announcement. `whenLabel` is the
 *  London "EEE d MMM 'at' HH:mm" label. */
export function buildMatchCancelledAnnouncement(args: { activityName: string; whenLabel: string }): string {
  return (
    `❌ *Match cancelled* — ${args.activityName} on ${args.whenLabel}.\n\n` +
    `Not enough players this week. See you next week!`
  );
}

/** Rows 123 to 126: the group's reply to an admin recruit ask, from what
 *  `inviteRecentPlayers` actually did (`analyze/route.ts`). `reason` is
 *  the lib's own sentence for the full-squad and no-match cases. */
export function buildRecruitAckReply(r: {
  ok: boolean;
  reason?: string | null;
  invited?: number | null;
  matchName?: string | null;
  need?: number | null;
  alreadyInvited?: number | null;
}): string {
  if (!r.ok) return r.reason ?? "Couldn't do that right now.";
  if (r.invited && r.invited > 0) {
    return `📣 On it — DM'd ${r.invited} recent player${r.invited === 1 ? "" : "s"} who hadn't replied, asking them to fill *${r.matchName}*${r.need ? ` (${r.need} spot${r.need === 1 ? "" : "s"} left)` : ""}. I'll add anyone who taps in. 🙏`;
  }
  if (r.reason) return r.reason;
  if (r.alreadyInvited && r.alreadyInvited > 0) {
    return `Already pinged the recent players for *${r.matchName}* — just waiting on their replies. 🙏`;
  }
  return `No new players to ask for *${r.matchName}* right now. 👍`;
}

/** Row 127: the two-team sheet the swap replies end with. Unlike
 *  `formatTeamsPost` the labels carry no colon, and a missing name is "?". */
export function buildTeamSheet(args: {
  redLabel: string;
  yellowLabel: string;
  red: Array<string | null>;
  yellow: Array<string | null>;
}): string {
  const list = (names: Array<string | null>) => names.map((n, i) => `${i + 1}. ${n ?? "?"}`).join("\n");
  return `*${args.redLabel}*\n${list(args.red)}\n\n*${args.yellowLabel}*\n${list(args.yellow)}`;
}

/** Row 128: a swap asked for before the teams exist. */
export function buildSwapDeferredReply(args: { a: string; b: string }): string {
  return (
    `Both *${args.a}* and *${args.b}* are already in — nobody's dropped. ` +
    `Teams aren't generated yet; say *generate teams* and I'll build them (then I can put them on opposite sides).`
  );
}

/** Row 129: two confirmed players swapped sides. */
export function buildTeamSwapReply(args: { a: string; b: string; sheet: string }): string {
  return `🔁 Swapped *${args.a}* and *${args.b}* — nobody dropped. Updated teams:\n\n${args.sheet}`;
}

/** Row 130: a replacement inherits the dropped player's slot. */
export function buildSlotTransferReply(args: { to: string; from: string; teamLabel: string; sheet: string }): string {
  return (
    `🔁 *${args.to}* takes *${args.from}*'s place on *${args.teamLabel}* — ` +
    `same teams otherwise, nothing regenerated, nobody's attendance changed. Updated teams:\n\n${args.sheet}`
  );
}

/** Row 131: the colours flipped, the sides unchanged. */
export function buildColourSwapReply(args: { sheet: string }): string {
  return `🎨 Swapped the colours — same teams, sides flipped:\n\n${args.sheet}`;
}

/** Row 62: `inviteRecentPlayers` with no upcoming match. */
export const RECRUIT_NO_MATCH_REFUSAL = "There's no upcoming match to invite players to.";

/** Row 61: `inviteRecentPlayers` into a full squad with the bench feature off. */
export function buildRecruitFullSquadRefusal(args: { matchName: string }): string {
  return `The squad for *${args.matchName}* is already full — no open spots to recruit for.`;
}

/** Row 60: `loadRatingProgress` with no completed match to check. */
export const RATING_PROGRESS_NO_MATCH_REASON = "There's no recent completed match to check yet.";

/** The balancer's three refusal reasons (`team-generation.ts`), which
 *  `composeBalancerRefusal` wraps as "Can't build teams right now — <reason>." */
export const TEAM_GEN_REASON_NOT_FOUND = "match not found";
export function teamGenReasonStatus(status: string): string {
  return `match is ${status.toLowerCase()}`;
}
export function teamGenReasonNotEnough(args: { confirmed: number; needed: number }): string {
  return `not enough confirmed players — ${args.confirmed}/${args.needed}`;
}
