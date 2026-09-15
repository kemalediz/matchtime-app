/**
 * A REPLACEMENT INHERITS THE SLOT THE DROPPED PLAYER LEFT BEHIND.
 *
 * Pure. No Prisma, no clock, no model. It reads the attendance rows and
 * the team sheet AS THEY WILL STAND and returns the moves that make the
 * sheet describe the squad again.
 *
 * ── THE INCIDENT: Sutton FC, 15 September 2026, kickoff 21:30 ────────
 *
 * Teams were generated at 16:41. At 19:14, two messages, minutes apart,
 * from two different people:
 *
 *   19:14  Wasim  "Salam guys… I feel a fever… If there is someone who
 *                  can take my place, then please do."   → OUT, DROPPED
 *   19:15  Amir   "Shahrokh can play in sha Allah"       → Shahrokh IN
 *
 * BOTH ATTENDANCE WRITES WERE CORRECT. The squad went 14 → 13 → 14 and
 * every row in the database said the right thing. What nothing touched
 * was the TEAM SHEET: Wasim kept his Yellow slot, Shahrokh had no slot
 * at all, and the last line-up standing in the group still named a man
 * who was at home with a fever. Yellow would have turned up with six.
 *
 * ── WHY THIS IS A STATE CHECK AND NOT AN EVENT CORRELATION ──────────
 *
 * The obvious reading of that transcript is "a drop, then a
 * replacement", and the obvious implementation is to remember the drop
 * and wait for the arrival. It would be wrong in three ways that the
 * live traffic actually produces:
 *
 *   • THE TWO MESSAGES NEED NOT SHARE A BATCH. The Pi buffers inbound
 *     messages and flushes a window; on the night these two landed in
 *     ONE flush, but a minute's difference either way and they are two
 *     requests with no memory between them.
 *   • THE ARRIVAL CAN COME FIRST. "Shahrokh can play" then "sorry, I'm
 *     out" is the same situation typed in the other order, and a
 *     correlation keyed on the drop misses it.
 *   • THE DROP NEED NOT COME FROM THIS PATH AT ALL. An admin can drop a
 *     player from the portal, or a DM can, and neither passes through
 *     the group batch that later hears about the replacement.
 *
 * So the question is asked of the WORLD rather than of the window:
 *
 *     Is there a CONFIRMED player with no slot, while the sheet still
 *     holds a slot for somebody who is no longer in the squad?
 *
 * That is true after either ordering, across any number of batches, and
 * however the two halves arrived. It is also false the instant it has
 * been acted on, so it cannot fire twice for the same pair.
 *
 * ── WHICH REPLACEMENT TAKES WHICH SLOT ───────────────────────────────
 *
 * Two drops and two arrivals have to resolve the same way every time,
 * including when a retry re-runs the batch. Both sides are therefore
 * put in an order that is a property of the data rather than of the
 * request:
 *
 *   VACANCIES  in TEAM-SHEET order — the order `load-state.ts` reads
 *              `TeamAssignment` rows, which is `id: asc`, i.e. the order
 *              the balancer wrote them (red block, then yellow). It is
 *              the order the group READ the sheet in.
 *   ARRIVALS   in ATTENDANCE POSITION order — the order they joined the
 *              squad. First in, first seated.
 *
 * Then they are zipped. The first replacement to have joined takes the
 * first vacancy on the sheet. No balancing, no Elo, no attempt to be
 * clever about which side needs a defender: this module moves a row, and
 * the moment it starts choosing a BETTER team than the one the player
 * left it has become the balancer, which the owner explicitly refused
 * ("teams are not generated").
 *
 * ── WHAT IT DELIBERATELY WILL NOT DO ─────────────────────────────────
 *
 *   • IT NEVER TOUCHES ATTENDANCE. There is no field on `SlotInherit`
 *     that could carry a status. Same enforcement, and the same reason,
 *     as `team-slot-swap.ts`: a swap moves a slot; it never drops, adds,
 *     benches or promotes.
 *   • IT NEVER SEATS A PLAYER INTO A SLOT NOBODY VACATED. A squad that
 *     GREW — a 15th confirmed player on a 14-slot sheet, or a sheet
 *     built while the squad was short — produces no vacancy, so it
 *     produces no move. The alternative would be to invent a slot, and
 *     a sheet with eight on one side is a worse lie than a sheet that is
 *     honestly one short.
 *   • IT NEVER FIRES WITHOUT A SHEET. No `TeamAssignment` rows means the
 *     teams have not been generated, and a player with no slot is then
 *     the normal state of the world rather than a defect.
 *
 * ── THE COLOUR SWAP, AND WHY IT NEEDS NO SPECIAL CASE ────────────────
 *
 * "@Match Time swap all yellow team players with red team players" is a
 * real Sutton command (it ran at 15:46 on the day of the incident) and
 * its handler flips the `team` ENUM on every assignment row — despite
 * logging "labels flipped", it is the rosters that move. So the enum on
 * the vacated row is always the side that player is ACTUALLY on right
 * now, and copying it is correct by construction. The display label is
 * resolved from the enum at render time by `resolveTeamLabels`, which
 * this module does not touch and must not.
 */

/** The two sides, as `TeamAssignment.team` stores them. */
export type InheritTeam = "RED" | "YELLOW";

/** One attendance row, as the world will have it after the writes. */
export interface InheritRow {
  userId: string;
  status: "CONFIRMED" | "BENCH" | "DROPPED";
  /** Squad position — the order they joined. Ties are impossible in the
   *  database (`position` is assigned by a counter) and are broken by
   *  `userId` here so the sort is total either way. */
  position: number;
}

/** One row of the team sheet, in sheet order. */
export interface InheritSlot {
  userId: string;
  team: InheritTeam;
}

/** Move the slot `fromUserId` holds onto `toUserId`. Nothing else. */
export interface SlotInherit {
  fromUserId: string;
  toUserId: string;
  team: InheritTeam;
}

/**
 * The whole rule. Returns the moves, in the order the pairs were made,
 * or an empty array when the sheet already describes the squad.
 *
 * `teams` MUST arrive in sheet order (`id: asc`) — see the header. The
 * caller that reads the database gets that for free from
 * `load-state.ts`, which orders by `id` and says why.
 */
export function decideSlotInherits(args: {
  rows: InheritRow[];
  teams: InheritSlot[];
}): SlotInherit[] {
  const { rows, teams } = args;
  // No sheet, nothing to inherit. Stated first because every other
  // branch below is meaningless without one.
  if (teams.length === 0) return [];

  const statusOf = new Map(rows.map((r) => [r.userId, r.status]));
  const seated = new Set(teams.map((t) => t.userId));

  // A slot held by somebody who is not in the squad any more. DROPPED
  // and BENCH both count, and so does a row that has vanished entirely:
  // the question is "is this person playing?", and only CONFIRMED is a
  // yes. Order is the caller's, which is sheet order.
  const vacancies = teams.filter((t) => statusOf.get(t.userId) !== "CONFIRMED");

  // A player in the squad with nowhere to stand. In the order they
  // joined, so the pairing cannot depend on which batch noticed them.
  const arrivals = rows
    .filter((r) => r.status === "CONFIRMED" && !seated.has(r.userId))
    .sort((a, b) => a.position - b.position || (a.userId < b.userId ? -1 : 1));

  const pairs = Math.min(vacancies.length, arrivals.length);
  const out: SlotInherit[] = [];
  for (let i = 0; i < pairs; i++) {
    out.push({
      fromUserId: vacancies[i].userId,
      toUserId: arrivals[i].userId,
      team: vacancies[i].team,
    });
  }
  return out;
}
