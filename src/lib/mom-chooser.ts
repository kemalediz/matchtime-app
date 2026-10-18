/**
 * WHO CHOOSES MAN OF THE MATCH (2026-10-18), `Organisation.momChosenBy`.
 *
 *   "players"     (default, every club before this): the players vote on
 *                 their rating link, and the result is announced from the
 *                 votes, exactly as before.
 *   "organisers"  the organisers pick on the pitch and report it in the
 *                 admin group with the score (`admin-group-score.ts`).
 *                 Players only rate each other: the rating page, the rating
 *                 DMs and the WhatsApp poll offer no vote.
 *
 * Either way the Man of the Match is stored the same way, as MoMVote rows
 * (`mom-pick.ts`), so the crown, the badges and the stats read one thing.
 *
 * PURE, no Prisma, so the settings page and the copy can import it.
 */

export type MomChooser = "players" | "organisers";

export const MOM_CHOOSERS: readonly MomChooser[] = ["players", "organisers"];

/** Anything the code does not recognise reads as "players": today's behaviour. */
export function normaliseMomChooser(v: string | null | undefined): MomChooser {
  return v === "organisers" ? "organisers" : "players";
}

/**
 * True when the organisers pick Man of the Match. Independent of the
 * "Man of the Match" switch (`featureMomVoting`), which only decides
 * whether the winner is announced in the group, as it does for a vote.
 */
export function organisersPickMom(org: { momChosenBy?: string | null } | null | undefined): boolean {
  return normaliseMomChooser(org?.momChosenBy) === "organisers";
}
