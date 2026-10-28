/**
 * The record that a match was marked as NOT PLAYED after kickoff (review of
 * #437, 7), as opposed to called off before it (announced to the group).
 * A SentNotification ledger row, like other markers: written with the
 * status, in one transaction, by `match-cancel.ts`; removed when the game
 * is put back. Only such a game can be put back as played, and an
 * after-game invitation withdrawn for it does not block the club asking
 * that player again (`pool/club-invitation.ts`). Its own module so the
 * readers need not import the cancel core.
 */
export const notPlayedKey = (matchId: string): string => `${matchId}:not-played`;
export const NOT_PLAYED_KIND = "not-played";
