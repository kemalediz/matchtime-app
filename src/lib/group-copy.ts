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
 */

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
}): string {
  const { confirmed, bench, maxPlayers } = args;
  const need = Math.max(0, maxPlayers - confirmed.length);
  const count = `*${confirmed.length}/${maxPlayers}*`;
  const lead =
    `📋 Based on all the messages I've picked up, here's the latest squad${bench.length > 0 ? " and bench" : ""} — ` +
    (need > 0 ? `${count}, need *${need} more* 🙏` : `${count} ✅ full squad.`);
  const rows: string[] = [];
  for (let i = 0; i < maxPlayers; i++) {
    rows.push(i < confirmed.length ? `${i + 1}. ${confirmed[i]}` : `${i + 1}. 🥁`);
  }
  const lines = [lead, "", "*Playing:*", ...rows];
  if (bench.length > 0) {
    lines.push("", `*Bench (${bench.length}):*`);
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
}): string {
  const listFor = (arr: { name: string }[]) =>
    arr.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
  return (
    `⚽ *Teams for tonight* — ${args.kickoff} at ${args.venue}\n\n` +
    `*${args.redLabel}*:\n${listFor(args.red)}\n\n` +
    `*${args.yellowLabel}*:\n${listFor(args.yellow)}\n\n` +
    `Objections? Reply \`swap X Y\` — admin will confirm.`
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

const CLAIM_NAME = "([A-Z][\\p{L}'-]+)";
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
  });
  const keepLead =
    wanted && lead.length > 0 && !displaysSquadState(lead) && !contradictsSquadState(lead, truth);
  return { text: keepLead ? `${lead}\n\n${post}` : post, composed: true };
}
