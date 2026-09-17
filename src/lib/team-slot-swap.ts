/**
 * "SWAP A WITH B" — WHO ENDS UP ON WHICH SIDE OF THE TEAM SHEET.
 *
 * The pure half of `api/whatsapp/analyze/route.ts`'s
 * `handleTeamSwapIfApplicable`. It reads two people's CURRENT state and
 * returns ONE of four decisions. It touches nothing: no Prisma, no
 * clock, no model. The caller loads the rows, calls `decideSwap`, and
 * applies exactly what came back.
 *
 * ── WHY IT EXISTS: the 2026-09-08 Elvin/Raihan incident ──────────────
 *
 * Sutton FC, the afternoon of a match:
 *
 *   15:25  Elvin:  "please can someone replace me, not feeling well"
 *                  → recorded OUT. DROPPED, and still holding a RED slot.
 *   16:15  Wasim:  "I have a friend who will play instead of my dad.
 *                   His name is Raihan"       → Raihan CONFIRMED, no slot.
 *   16:47  Kemal:  "@Match Time do not regenerate the teams. Instead
 *                   swap Elvin with Raihan and share us the teams"
 *                  → NOTHING HAPPENED.
 *
 * The regex matched. The handler then declined on its own rule — "both
 * must resolve uniquely AND both be CONFIRMED for this to be a team
 * swap" — because Elvin was DROPPED. The message fell through to the
 * `balancer` route, which owns `show` and `generate` and no `swap` at
 * all, so the owner got one operator DM saying
 * `team action "swap" is not a read (no module owns it)` and the team
 * sheet still listed a player who had pulled out four hours earlier.
 *
 * The both-CONFIRMED rule was never wrong; it was just half the
 * feature. A replacement — one player out, one player in, the line-up
 * following the body — is the most common team edit this club makes.
 *
 * ── THE FOUR DECISIONS ───────────────────────────────────────────────
 *
 *   team-swap      Both CONFIRMED. They exchange sides. UNCHANGED from
 *                  the shipped handler, including its defensive case
 *                  where only one of the two holds a slot.
 *   defer-no-teams Both CONFIRMED, neither holds a slot: the teams have
 *                  not been generated. Acknowledge, DROP NOBODY, and
 *                  say what would build them. UNCHANGED.
 *   slot-transfer  Exactly one side is CONFIRMED and holds NO slot, and
 *                  the other side holds a slot but is NOT CONFIRMED.
 *                  Move the slot from the second to the first. NEW.
 *   refuse         Everything else, with a named reason. Since
 *                  2026-09-17 the caller ANSWERS a refusal (`planSwap`
 *                  below) and still sends the whole message on, and
 *                  the engine refuses any attendance claim about the
 *                  two names (`isSwapParty`). Before that a refusal
 *                  fell through silently, and the pipeline read the
 *                  swap as a drop.
 *
 * ── WHY `slot-transfer` IS A REPAIR AND NOT A GUESS ──────────────────
 *
 * Teams are only ever built from CONFIRMED attendance — `team-
 * generation.ts` and `actions/teams.ts` both feed the balancer from
 * `status: CONFIRMED` rows and then `deleteMany` + `createMany` the
 * whole sheet. So "holds a slot but is not CONFIRMED" is not a state
 * the system can create; it is only ever a STALE sheet, a player
 * dropped or benched after the teams were built. Meanwhile "CONFIRMED
 * and holds no slot" is the other half of the same staleness: someone
 * who joined after the sheet was made. The transfer moves one to the
 * other. Both halves of the sheet get MORE correct and neither player's
 * attendance is read as changed.
 *
 * ── THE THINGS IT REFUSES, AND WHY EACH IS A REFUSAL, NOT A GUESS ────
 *
 *   receiver-not-confirmed  The side that would RECEIVE the slot is not
 *          CONFIRMED (BENCH, DROPPED, or has no attendance row at all).
 *          Handing them a slot would put a non-squad player on the team
 *          sheet, and the only correct way to get a bench player INTO
 *          the squad is `bench-confirmation.ts`, which flips their
 *          attendance first. This module must not touch attendance, so
 *          it must not do half of that.
 *   both-hold-slots  One side is not CONFIRMED and BOTH hold slots.
 *          Exchanging them would leave a player who is not coming still
 *          on the sheet, just in a different colour. The person asking
 *          may have meant something else entirely; a wrong team sheet
 *          is worse than a message they have to repeat.
 *   nobody-is-playing  NEITHER side is CONFIRMED. There is no correct
 *          occupant to move a slot TO.
 *   no-slot-to-move  There is no slot on the non-CONFIRMED side to
 *          move. Includes the already-correct case (the CONFIRMED side
 *          holds the slot and the other holds none), where the sheet
 *          says what it should already.
 *   same-player  The two names resolved to one person.
 *
 * ── WHAT THIS MODULE IS NOT ALLOWED TO DO ────────────────────────────
 *
 * NO ATTENDANCE. Nothing here returns a status. A swap moves a slot; it
 * never drops, adds, benches or promotes. `SwapDecision` has no field
 * that could carry one, which is the enforcement.
 *
 * NO BALANCER. Not one branch proposes regenerating. The message that
 * caused this file said "do not regenerate the teams" in its own words,
 * and 2026-06-18 (`c408649`) is the incident where re-running the
 * balancer over a hand-made line-up on match night is what went wrong.
 * `team-ops-engine-batch.ts`'s header refuses `rename` for the same
 * reason and hands `swap` back to this deterministic path on purpose.
 *
 * ── SYMMETRY IS A PROPERTY, NOT A CONVENTION ─────────────────────────
 *
 * "swap Elvin with Raihan" and "swap Raihan with Elvin" are the same
 * request. Every branch below is written on ROLES (who is playing, who
 * holds a slot) rather than on argument position, so the two orderings
 * cannot diverge; `__tests__/team-slot-swap.test.ts` asserts that over
 * the whole 8×8 matrix rather than trusting the reading.
 *
 * ── THE INTERACTION CONTRACT: TAG YES, ADMIN SEAT NO ─────────────────
 *
 * The caller already requires an `@Match Time` tag for both swap peels
 * and that does not change. No ADMIN gate is added, and the argument is
 * the same one `interaction-contract.ts` makes for its own lines:
 *
 *   - `ADMIN_REPORTED_OUT_IS_TAG_FREE` waives a tag for an admin's
 *     third-party OUT because it RECORDS A FACT the player reported.
 *   - `registerForEntryRequiresTag` keeps the tag on BENCH because a
 *     demote "leaves the player in the squad in a worse position… it is
 *     roster surgery", and because the engine's admin-only bench guard
 *     has already spent the seat as its authorisation.
 *
 * A slot transfer is neither. Nobody's squad standing changes: the
 * donor is already not playing, the receiver is already playing. It
 * moves a `TeamAssignment` row, which is what the shipped both-
 * CONFIRMED swap has done, tag-only, since 2026-05-19. And the person
 * who knows a replacement has arrived is usually the player who brought
 * them — on 2026-09-08 that was Wasim, not an admin — so an admin gate
 * would refuse exactly the person holding the information. The tag is
 * the deliberate act; the reply posts the resulting sheet so the group
 * sees it immediately; one more message reverses it.
 */

export type SwapAttendance = "CONFIRMED" | "BENCH" | "DROPPED" | "NONE";
export type SwapTeam = "RED" | "YELLOW";

/** One side of a swap, as the database has it right now. `status:
 *  "NONE"` means there is no `Attendance` row for this match at all. */
export interface SwapSide {
  userId: string;
  name: string;
  status: SwapAttendance;
  /** The team they currently hold a `TeamAssignment` for, or null. */
  team: SwapTeam | null;
}

/** Same shape, read as a member of the pool a name is resolved against. */
export type SwapCandidate = SwapSide;

export type SwapRefusalReason =
  | "same-player"
  | "nobody-is-playing"
  | "receiver-not-confirmed"
  | "both-hold-slots"
  | "no-slot-to-move";

export type SwapDecision =
  | { kind: "team-swap"; a: SwapSide; b: SwapSide; teamForA: SwapTeam; teamForB: SwapTeam }
  | { kind: "defer-no-teams"; a: SwapSide; b: SwapSide }
  | { kind: "slot-transfer"; from: SwapSide; to: SwapSide; team: SwapTeam }
  | { kind: "refuse"; reason: SwapRefusalReason };

const opposite = (t: SwapTeam): SwapTeam => (t === "RED" ? "YELLOW" : "RED");

/**
 * THE TURKISH FORM (2026-09-17): "A ile B'yi değiştir" (also "A ve B'yi
 * değiştir", "…değiştirir misin"), which is what the Turkish copy tells a
 * group to type. Without it the router sent "@Match Time David ile
 * Ali'yi değiştir" to `other_att` 10 of 10 (rule 4, exactly as it does
 * the English "swap David and Abid") and nothing moved a slot.
 *
 * The second name carries the accusative ending after an apostrophe
 * ('yi, 'ı, 'u …, straight or curly), which is dropped: the roster knows
 * "Can", not "Can'ı". An ending typed WITHOUT the apostrophe ("Canı") is
 * kept, does not resolve, and the handler declines, which is the safe
 * direction for a terminal pre-peel. The verb list is closed and has no
 * "değiştirme" ("do not swap").
 */
const TR_SWAP =
  /(?<!\p{L})(\p{L}[\p{L}-]+)\s+(?:ile|ve)\s+(\p{L}[\p{L}-]+)(?:['’]\p{L}{1,3})?\s+de[gğ]i[sş]tir(?:in|elim|sene|ir\s+misin|ebilir\s+misin)?(?!\p{L})/iu;
/** Words the Turkish form can capture that are never a player: the
 *  colours (the colour swap owns those, and it runs first) and the
 *  nouns of "renkleri ve takımları değiştir". */
const TR_NOT_A_NAME =
  /^(?:k[ıi]rm[ıi]z[ıi]\p{L}*|sar[ıi](?:y[ıi]|yla|la)?|renk\p{L}*|tak[ıi]m\p{L}*|forma\p{L}*)$/u;

/**
 * Pull two first names out of "swap A with B" / "switch A and B" /
 * "swap A for B" / "swap A & B" / "swap A, B". Lower-cased; the caller
 * resolves them against the roster.
 *
 * Carried over from the shipped handler with ONE tightening: a `\b`
 * after each captured name, so the engine can no longer backtrack
 * INSIDE a single word. "no swap needed" used to come back as
 * `need` + `ed` and be saved only by neither half resolving to a
 * player. That is a narrowing — the peel matches strictly fewer
 * messages than it did — which is the safe direction for a terminal
 * pre-peel.
 */
export function parseSwapNames(rawBody: string): { a: string; b: string } | null {
  const body = (rawBody || "").trim();
  const en = body.match(
    /\b(?:swap|switch)\s+([\p{L}'-]{2,})\b\s*(?:with|and|for|&|,|<->|>|\/)?\s*([\p{L}'-]{2,})\b/iu,
  );
  const m = en ?? body.match(TR_SWAP);
  if (!m) return null;
  const a = m[1].toLowerCase();
  const b = m[2].toLowerCase();
  // Only for the Turkish form: "Sari" is somebody's name in English.
  if (!en && (TR_NOT_A_NAME.test(a) || TR_NOT_A_NAME.test(b))) return null;
  if (a === b) return null;
  // Obvious non-name tokens. "swap the colours" must never reach the
  // roster (and the colour peel runs first anyway).
  const STOP = new Set([
    "the", "them", "him", "her", "with", "and", "for", "team", "teams",
    "side", "sides", "please", "pls",
  ]);
  if (STOP.has(a) || STOP.has(b)) return null;
  return { a, b };
}

const norm = (s: string) =>
  s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function nameMatches(query: string, name: string): boolean {
  const qq = norm(query);
  const nm = norm(name);
  const first = nm.split(/\s+/)[0] ?? "";
  return nm === qq || first === qq || nm.startsWith(qq) || first.startsWith(qq);
}

/**
 * Resolve ONE name against the pool, or null if it is ambiguous or
 * unknown. Same matching as the shipped handler (exact, first name, or
 * prefix of either) — what changed is the POOL.
 *
 * TWO STAGES, AND THE ORDER IS THE POINT. The shipped handler searched
 * CONFIRMED attendees only, so a DROPPED Elvin was invisible and the
 * incident could not be read at all. Searching everybody instead would
 * have fixed that and broken something else: a name that resolved
 * UNIQUELY among the confirmed can be ambiguous across the whole
 * roster (two Omars, one playing, one who dropped out weeks ago), and
 * the shipped both-CONFIRMED swap would start returning null on
 * messages it handles today.
 *
 * So: a unique CONFIRMED match wins outright, exactly as before. Only
 * when there is NO confirmed match at all does the wider pool get a
 * turn, and it too must be unique. Strictly additive: every name that
 * resolved before resolves to the same person.
 */
export function resolveSwapSide(
  query: string,
  roster: SwapCandidate[],
): SwapCandidate | null {
  const r = resolveSwapSideDetailed(query, roster);
  return r.kind === "resolved" ? r.side : null;
}

/** `resolveSwapSide`, saying WHY it found nobody. The two misses are
 *  told apart only so the refusal can say which one it was; the rule is
 *  the same function. */
type SideResolution =
  | { kind: "resolved"; side: SwapCandidate }
  | { kind: "ambiguous"; candidates: SwapCandidate[] }
  | { kind: "unknown" };

function resolveSwapSideDetailed(query: string, roster: SwapCandidate[]): SideResolution {
  const hits = roster.filter((c) => nameMatches(query, c.name));
  const confirmed = hits.filter((c) => c.status === "CONFIRMED");
  if (confirmed.length === 1) return { kind: "resolved", side: confirmed[0] };
  // Ambiguous among the playing: the candidates are the playing ones.
  if (confirmed.length > 1) return { kind: "ambiguous", candidates: confirmed };
  if (hits.length === 1) return { kind: "resolved", side: hits[0] };
  return hits.length > 1 ? { kind: "ambiguous", candidates: hits } : { kind: "unknown" };
}

// ═══════════════════════════════════════════════════════════════════════
// A SWAP REQUEST IS NEVER ATTENDANCE (2026-09-17)
// ═══════════════════════════════════════════════════════════════════════
//
// THE BUG. A swap this module REFUSES (an unknown or ambiguous name, the
// teams not built) used to fall through, whole and silent, to the
// attendance pipeline, and so did every UNTAGGED swap. The extractor
// reads "swap David and Sait" as David leaving, with the same shape a
// real drop has (`basis=decision polarity=out`). Measured live on the
// Sutton squad, REPEAT=10 (`scripts/dryrun-pipeline.ts`, TR26 / TR27):
//
//   "@Match Time swap David and Sait"          DROPPED David 10 of 10
//   "@Match Time David ile Sait'i değiştir"    DROPPED David  9 of 10
//
// And an admin needs no tag to drop another player
// (`ADMIN_REPORTED_OUT_IS_TAG_FREE`), so the untagged form did it too.
// A player silently removed from a squad he never left.
//
// ── WHY THE FIX IS HERE, IN CODE, AND NOT IN A PROMPT ────────────────
//
// Three layers could own it. The ROUTER sends a swap to `other_att` on
// purpose (rule 4: "moving, benching or swapping a named player"), and
// every edit to that prompt carries the 373-message veto for a reason
// written at the top of `router.ts`. The EXTRACTOR could be taught a
// third `basis`, but a sentence of prose asking a model to tell "swap
// David" from "drop David" is a probability, and the thing it protects
// is the one error this product cannot afford. The ENGINE already holds
// the message body and a deterministic parser for exactly this sentence
// (`parseSwapNames`, the fast path's own), so the answer can be a
// property of the code: a claim about a person the message asks to
// SWAP is never an attendance change for that person, whatever the
// model read. `pipeline/engine.ts` asks `isSwapParty` of every claim.
//
// ── WHY PER NAME, AND NEVER PER MESSAGE ──────────────────────────────
//
// `parseSwapNames` is a fast-path parser and it is loose on purpose: the
// fast path then insists both names are real people. "@Kemal switch it
// to 7 a side and put Amir in as the 14th" parses as a swap of "it" and
// "to", and it is router rule 15's own example of a message that MUST
// register Amir. Refusing every claim in a message that parses as a swap
// would lose him. Refusing only claims about "it" and "to" loses nothing.
// Likewise "swap David and Sait, and I'm out": the sender is not a
// party, so his own drop still lands, and "swap David and Sait. Zeeshan
// is out" still drops Zeeshan.
//
// ── HOW A CLAIM IS MATCHED TO A NAME ─────────────────────────────────
//
// By TOKEN EQUALITY, not by the prefix match the fast path resolves
// with. Both strings come from the same message, so the extractor's
// `personRef` for David IS "David" (verbatim is its contract); a prefix
// match would only add wrong answers ("to" would swallow "Tony"). The
// forms normalised away are the ones the same message produces: case,
// diacritics, a leading "@", the full name the extractor sometimes
// copies from a mention, and the Turkish case ending after an apostrophe
// ("Sait'i").

/**
 * The sender, as a swap names them. English only, and closed.
 *
 * NOT the Turkish "ben" / "beni", and the reason is a name: "Ben" is a
 * common English first name, so "swap Ben with Pat" read the SENDER as a
 * party (caught by `e2e/api/team-slot-swap.spec.ts`), and in the engine
 * "swap Ben with Pat, and I'm out" would have refused the sender's own
 * drop. The Turkish copy never tells anyone to swap themselves, so the
 * Turkish words buy nothing and cost exactly that.
 */
const SWAP_SELF_WORDS = new Set(["me", "myself"]);

function swapToken(s: string): string {
  return norm(s)
    .replace(/^@+/, "")
    .replace(/['’]\p{L}{1,3}$/u, "");
}

/**
 * Is this attendance claim about one of the two people a swap request
 * names? See the block above. `parties` is `parseSwapNames` of the same
 * message body.
 */
export function isSwapParty(
  claim: { subject: "sender" | "other"; personRef: string },
  parties: { a: string; b: string },
): boolean {
  const a = swapToken(parties.a);
  const b = swapToken(parties.b);
  if (claim.subject === "sender") return SWAP_SELF_WORDS.has(a) || SWAP_SELF_WORDS.has(b);
  const tokens = claim.personRef
    .split(/[\s,]+/)
    .map(swapToken)
    .filter((t) => t.length > 0);
  return tokens.includes(a) || tokens.includes(b);
}

// ── THE REFUSAL, NAMED ───────────────────────────────────────────────

/** Why a real swap was not applied, in terms the owner can act on. */
export type SwapRefusal =
  | { reason: "unknown-name"; name: string }
  | { reason: "ambiguous-name"; name: string; candidates: string[] }
  | { reason: "teams-not-generated" }
  | { reason: "same-player" }
  | { reason: "nobody-is-playing" }
  | { reason: "receiver-not-confirmed"; name: string }
  | { reason: "both-hold-slots"; name: string }
  | { reason: "no-slot-to-move"; name: string };

export type SwapPlan =
  /** `decideSwap` said something other than refuse. Apply it. */
  | { kind: "decided"; decision: Exclude<SwapDecision, { kind: "refuse" }> }
  /** A real player swap that cannot be applied. `a` and `b` are the
   *  roster's names where they resolved, the typed word otherwise. */
  | { kind: "refused"; a: string; b: string; why: SwapRefusal }
  /** Neither word is a person ("switch it to 7 a side"). The fast path
   *  owns nothing, exactly as before. */
  | { kind: "not-a-player-swap" };

const typed = (w: string) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w);

/**
 * `handleTeamSwapIfApplicable`'s whole decision, pure.
 *
 * WHAT IT ADDS TO `decideSwap`, AND WHY:
 *
 *   - It tells a message that is not a player swap at all from a swap it
 *     cannot apply. The first stays unowned, as it always was. The
 *     second used to be unowned too, and that is the bug: the owner
 *     heard nothing, and the pipeline dropped a player. It is now
 *     answered, and the analyze route still sends the whole message on
 *     so nothing else in it is lost.
 *   - The line between them: a swap is REAL when at least one of the two
 *     words is somebody in this match (resolved or ambiguous). "switch
 *     it to" names nobody and stays silent; "swap David and Zork" names
 *     David and is told Zork is unknown.
 *   - "me" is the sender. Without it, "swap me with David" could only
 *     ever be refused as an unknown player called "Me". A sender with no
 *     attendance row is a real side with status NONE, and `decideSwap`
 *     refuses them for the reason it refuses anyone in that state. This
 *     widens what the fast path APPLIES by exactly that phrasing, and it
 *     moves a slot only between people `decideSwap` already allows.
 *   - `no-slot-to-move` with no team sheet at all is reported as the
 *     teams not being built, because that is the reason the owner can
 *     act on. `decideSwap` itself is unchanged.
 */
export function planSwap(
  names: { a: string; b: string },
  roster: SwapCandidate[],
  opts: { sender: { userId: string; name: string } | null; teamsExist: boolean },
): SwapPlan {
  const side = (word: string): SideResolution => {
    if (SWAP_SELF_WORDS.has(swapToken(word))) {
      if (!opts.sender) return { kind: "unknown" };
      const own = roster.find((c) => c.userId === opts.sender!.userId);
      return {
        kind: "resolved",
        side: own ?? { userId: opts.sender.userId, name: opts.sender.name, status: "NONE", team: null },
      };
    }
    return resolveSwapSideDetailed(word, roster);
  };
  // IS THIS A PLAYER SWAP AT ALL? Asked with EXACT names, not with the
  // prefix match below. `nameMatches` lets "to" find Tom Third, which is
  // right for resolving a name once we know the message is a swap and
  // wrong for deciding that it is one: "@Match Time switch it to 7 a
  // side" was answered "I haven't swapped It and Tom Third" (the e2e
  // suite caught it). A word counts only when it IS somebody's first or
  // full name, or "me" from a known sender.
  const isExactly = (word: string): boolean => {
    const w = swapToken(word);
    if (SWAP_SELF_WORDS.has(w)) return opts.sender !== null;
    return roster.some((c) => {
      const n = norm(c.name);
      return n === w || n.split(/\s+/)[0] === w;
    });
  };
  if (!isExactly(names.a) && !isExactly(names.b)) return { kind: "not-a-player-swap" };

  const A = side(names.a);
  const B = side(names.b);

  const shown = (r: SideResolution, word: string) => (r.kind === "resolved" ? r.side.name : typed(word));
  const a = shown(A, names.a);
  const b = shown(B, names.b);
  const refused = (why: SwapRefusal): SwapPlan => ({ kind: "refused", a, b, why });

  // Name problems first, in message order: the owner fixes the first
  // one and asks again.
  for (const [r, word] of [
    [A, names.a],
    [B, names.b],
  ] as const) {
    if (r.kind === "unknown") return refused({ reason: "unknown-name", name: typed(word) });
    if (r.kind === "ambiguous") {
      return refused({
        reason: "ambiguous-name",
        name: typed(word),
        candidates: r.candidates.map((c) => c.name),
      });
    }
  }
  if (A.kind !== "resolved" || B.kind !== "resolved") return { kind: "not-a-player-swap" }; // unreachable

  const decision = decideSwap(A.side, B.side);
  if (decision.kind !== "refuse") return { kind: "decided", decision };

  // The side that is NOT playing, for the reasons that are about it.
  const idle = A.side.status === "CONFIRMED" ? B.side : A.side;
  switch (decision.reason) {
    case "same-player":
    case "nobody-is-playing":
      return refused({ reason: decision.reason });
    case "no-slot-to-move":
      return opts.teamsExist
        ? refused({ reason: "no-slot-to-move", name: idle.name })
        : refused({ reason: "teams-not-generated" });
    case "receiver-not-confirmed":
    case "both-hold-slots":
      return refused({ reason: decision.reason, name: idle.name });
  }
}

/**
 * The whole rule, as one table over (is this side playing?) × (does
 * this side hold a slot?). Written on roles, so it is symmetric by
 * construction.
 */
export function decideSwap(a: SwapSide, b: SwapSide): SwapDecision {
  if (a.userId === b.userId) return { kind: "refuse", reason: "same-player" };

  const aPlaying = a.status === "CONFIRMED";
  const bPlaying = b.status === "CONFIRMED";

  // ── 1. BOTH PLAYING → the shipped team swap, byte-for-byte ─────────
  if (aPlaying && bPlaying) {
    if (!a.team && !b.team) return { kind: "defer-no-teams", a, b };
    // The defensive one-sided case from the shipped handler: the side
    // without a slot takes the other's, and the other moves across.
    const teamForA = b.team ?? opposite(a.team as SwapTeam);
    const teamForB = a.team ?? opposite(b.team as SwapTeam);
    return { kind: "team-swap", a, b, teamForA, teamForB };
  }

  // ── 2. NEITHER PLAYING → there is no correct occupant ──────────────
  if (!aPlaying && !bPlaying) return { kind: "refuse", reason: "nobody-is-playing" };

  // ── 3. EXACTLY ONE PLAYING → the replacement case, or a refusal ────
  const playing = aPlaying ? a : b;
  const other = aPlaying ? b : a;

  if (playing.team && other.team) {
    // Swapping these would leave a player who is not coming on the
    // sheet, in a different colour. Ambiguous; refuse.
    return { kind: "refuse", reason: "both-hold-slots" };
  }
  if (playing.team && !other.team) {
    // The slot is already on the right person. The only move available
    // would be to hand it to somebody who is not in the squad.
    return { kind: "refuse", reason: "receiver-not-confirmed" };
  }
  if (!playing.team && !other.team) {
    return { kind: "refuse", reason: "no-slot-to-move" };
  }

  // The one new case: a stale slot on somebody who is not playing,
  // and a player who is playing with no slot. Move it.
  return {
    kind: "slot-transfer",
    from: other,
    to: playing,
    team: other.team as SwapTeam,
  };
}
