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
 *   refuse         Everything else, with a named reason. The caller
 *                  falls through to ordinary handling, exactly as it
 *                  does today for every non-both-CONFIRMED shape.
 *
 * ── WHY `slot-transfer` IS A REPAIR AND NOT A GUESS ──────────────────
 *
 * Teams are only ever built from CONFIRMED attendance — `team-
 * generation.ts` feeds the balancer from `status: CONFIRMED` rows and
 * then `deleteMany` + `createMany` the whole sheet, and since
 * 2026-09-15 it is the ONLY thing that builds a sheet (the admin
 * dashboard's Generate button delegates to it rather than keeping its
 * own copy). So "holds a slot but is not CONFIRMED" is not a state
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
  const m = body.match(
    /\b(?:swap|switch)\s+([\p{L}'-]{2,})\b\s*(?:with|and|for|&|,|<->|>|\/)?\s*([\p{L}'-]{2,})\b/iu,
  );
  if (!m) return null;
  const a = m[1].toLowerCase();
  const b = m[2].toLowerCase();
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
  const hits = roster.filter((c) => nameMatches(query, c.name));
  const confirmed = hits.filter((c) => c.status === "CONFIRMED");
  if (confirmed.length === 1) return confirmed[0];
  if (confirmed.length > 1) return null; // ambiguous among the playing
  return hits.length === 1 ? hits[0] : null;
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
