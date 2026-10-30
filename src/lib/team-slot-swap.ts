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
 *                  two names (`swapGuardFor`). Before that a refusal
 *                  fell through silently, and the pipeline read the
 *                  swap as a drop.
 *
 * ── WHY `slot-transfer` IS A REPAIR AND NOT A GUESS ──────────────────
 *
 * Teams are only ever built from CONFIRMED attendance — `team-
 * generation.ts` feeds the balancer from `status: CONFIRMED` rows and
 * then `deleteMany` + `createMany` the whole sheet, and since
 * 2026-09-15 the admin dashboard's Generate button delegates to it
 * rather than keeping its own copy. The noon cron at
 * `api/cron/generate-teams/route.ts` builds no sheets since 2026-09-29,
 * so the argument below holds whichever path wrote the rows. So "holds a slot but is not CONFIRMED" is not a state
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
// A SWAP REQUEST IS NEVER ATTENDANCE (2026-09-17; read from facts since 2026-10-30)
// ═══════════════════════════════════════════════════════════════════════
//
// THE BUG IT GUARDS. The attendance extractor once read "swap David and
// Sait" as David leaving, with the shape a real drop has
// (`polarity=out`, not contingent). Measured live on the Sutton squad,
// REPEAT=10 (TR26 / TR27): DROPPED David 10 of 10, and 9 of 10 for the
// Turkish "David ile Sait'i değiştir". An admin needs no tag to drop
// another player, so the untagged form did it too.
//
// HOW IT IS GUARDED NOW: FACTS, NEVER THE WORDS (Kemal, 2026-10-30, "no
// string parsing at all"). Until then this guard ran a swap regex over
// the body (`parseSwapNames`, `parseSwapRequest`, a stop-word list, an
// "I'm out" pattern). All of that is deleted. What it reads instead:
//
//   1. The ROUTER sends a players'-group swap to `balancer`, so a plain
//      swap never reaches the attendance engine at all.
//   2. A message that does reach it and ALSO asks for a team change ("I'm
//      out, swap Kai with Ali") carries the attendance extractor's
//      "teams" side request. For exactly those messages the attendance
//      batch asks the TEAMS extractor what the change is
//      (`EngineMessage.teamsReading`), and this guard reads its parties:
//      `moves`, `swaps` and `pairings`. A person whose team the message
//      changes is staying in the squad, so no attendance claim about them
//      is applied.
//
// PER PERSON, NEVER PER MESSAGE: "swap David and Sait. Zeeshan is out"
// still drops Zeeshan, and the sender's own "and I'm out" still lands when
// the sender is not a party. A claim is matched to a party by resolving
// both through the match's roster (`resolveSwapSideDetailed`, the swap's
// own resolution), so "David", "@David" and "David Smith" are one person;
// a name nobody carries is matched to the same name only.
//
// A STATED REPLACEMENT IS NOT A SWAP: a claim that is part of one (it
// carries `replaces`, or another claim in the message `replaces` its
// person) is left alone. "Raihan in for Elvin" is attendance, and
// `pipeline/replacement.ts` moves the slot.
//
// THE SENDER is refused only when the change is a two-player swap that
// `planSwap` would APPLY (both in the squad, or a stale slot to hand
// on): then nobody is leaving. A swap naming the sender that cannot be
// applied is a substitution ("swap me with Kieran" with Kieran on the
// bench), and the sender's OUT is the point of it. For any other change
// shape, the sender's claim is refused only while they are CONFIRMED.
//
// THE LIMIT, said plainly. The regex once let "swap me with Kieran, I
// can't make it" drop the sender even when both were in the squad,
// because it spotted "I can't make it". No fact separates that from a
// misread team swap, so when both are in the squad the swap wins and the
// sender keeps his place; the reply shows the swap, and one more "out"
// reverses it.

/** The slice of the teams extractor's facts the guard reads. */
export interface SwapReading {
  action: string;
  moves?: string[];
  swaps: Array<{ personRef: string }>;
  pairings?: string[][];
  swapSides?: boolean;
}

/** The slice of an attendance claim the guard reads. */
export interface SwapGuardClaim {
  subject: "sender" | "other";
  personRef: string;
  replaces?: string;
}

const SWAP_SELF_WORDS = new Set(["me", "myself"]);

function swapToken(s: string): string {
  return norm(s)
    .replace(/^@+/, "")
    .replace(/['’]\p{L}{1,3}$/u, "");
}

/**
 * THE ENGINE'S QUESTION, WHOLE: given the teams extractor's reading of a
 * message (null when there is none), which of its attendance claims are
 * about a person the message moves between the teams? Null when the
 * guard does not fire at all. See the block above.
 */
export function swapGuardFor(
  reading: SwapReading | null | undefined,
  claims: SwapGuardClaim[],
  roster: SwapCandidate[],
  opts: { sender: { userId: string; name: string } | null; teamsExist: boolean },
): { parties: string[]; refuses: (c: SwapGuardClaim) => boolean } | null {
  if (!reading || reading.action !== "swap") return null;
  const moves = (reading.moves ?? []).map((m) => m.trim()).filter(Boolean);
  const parties = [
    ...moves,
    ...reading.swaps.map((s) => (s.personRef ?? "").trim()),
    ...(reading.pairings ?? []).flat().map((p) => p.trim()),
  ].filter(Boolean);
  if (parties.length === 0) return null;

  const SENDER = opts.sender ? opts.sender.userId : "\u0000sender";
  /** One person, as a key: a roster user id, the sender, or the name. */
  const who = (ref: string): string => {
    const token = swapToken(ref);
    if (SWAP_SELF_WORDS.has(token)) return SENDER;
    const r = resolveSwapSideDetailed(token, roster);
    return r.kind === "resolved" ? r.side.userId : `name:${token}`;
  };
  const claimWho = (c: SwapGuardClaim): string => (c.subject === "sender" ? SENDER : who(c.personRef));

  const partyKeys = new Set(parties.map(who));
  const inReplacement = new Set<string>();
  for (const c of claims) {
    const replaced = (c.replaces ?? "").trim();
    if (!replaced) continue;
    inReplacement.add(claimWho(c));
    inReplacement.add(who(replaced));
  }

  const twoPlayers =
    reading.swapSides !== true &&
    moves.length === 2 &&
    reading.swaps.length === 0 &&
    !(reading.pairings ?? []).some((g) => g.length > 0);
  const senderRefusable = (): boolean => {
    if (!opts.sender) return false;
    if (twoPlayers) return planSwap({ a: moves[0], b: moves[1] }, roster, opts).kind === "decided";
    return roster.some((c) => c.userId === opts.sender!.userId && c.status === "CONFIRMED");
  };

  return {
    parties,
    refuses: (c) => {
      const k = claimWho(c);
      if (!partyKeys.has(k) || inReplacement.has(k)) return false;
      return c.subject === "sender" ? senderRefusable() : true;
    },
  };
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
  const plan = planSwapInner(names, roster, opts);
  // ── THE SELF-PARTY RULE (review of PR #99) ─────────────────────────
  //
  // "swap me with Kieran" is two different requests. When both are in
  // the squad (teams built or not), nobody is leaving and it is a TEAM
  // swap: `decideSwap` applies or defers it. In every other state
  // (Kieran on the bench, the sender not in, no slot to move) it is a
  // SUBSTITUTION, "Kieran takes my place", and the sender's OUT is the
  // point of the message. So a swap that names the sender is owned only
  // when `decideSwap` would act on it; otherwise it is not a two-player
  // swap at all, the fast path stays silent (a reply saying "nobody was
  // dropped" would contradict the drop), and the engine guard lets the
  // sender's own claim through.
  const selfParty = [names.a, names.b].some((w) => SWAP_SELF_WORDS.has(swapToken(w)));
  if (selfParty && plan.kind === "refused") {
    return { kind: "not-a-player-swap" };
  }
  return plan;
}

function planSwapInner(
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

  // AN UNKNOWN WORD NEXT TO A REAL PLAYER IS A PLAYER. "swap david and
  // zork" is a real swap with a name MatchTime does not know, and must be
  // answered and must not drop David, typed in any case: this group
  // types in lowercase. A first cut asked for a capital letter and
  // reopened the original bug for exactly that typing. What is NOT a
  // player is the teams extractor's call: it names people only, so
  // "switch it to 7 a side" never reaches here with "it" and "to".

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
