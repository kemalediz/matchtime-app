/**
 * THE POOL'S QUESTION IN A CLUB'S ADMIN GROUP: ITS ASK REF (local player
 * pool L10, 2026-10-24). Pure, no imports, so the safe-YES rule, the
 * scheduler and the pool's HQ door share one spelling.
 *
 *   pool-ask:<matchId>   the short-squad notice's pool line ("Or I can ask
 *                        nearby players from the MatchTime pool: reply YES
 *                        here"), waiting for an organiser's YES
 */
export const POOL_ASK_PREFIX = "pool-ask:";

export const poolAskRef = (matchId: string): string => `${POOL_ASK_PREFIX}${matchId}`;

function after(prefix: string, ref: string): string | null {
  if (!ref.startsWith(prefix)) return null;
  const id = ref.slice(prefix.length);
  return id ? id : null;
}

export const parsePoolAskRef = (ref: string): string | null => after(POOL_ASK_PREFIX, ref);

/** The latest pool notice per match among MatchTime's logged HQ questions,
 *  oldest first. Rows of any other ref are not read. */
export function latestPoolNoticeAsks(rows: ReadonlyArray<{ askRef: string | null; createdAt: Date }>): Array<{ matchId: string; askedAt: Date }> {
  const latest = new Map<string, Date>();
  for (const r of rows) {
    const matchId = r.askRef ? parsePoolAskRef(r.askRef) : null;
    if (!matchId) continue;
    const seen = latest.get(matchId);
    if (!seen || r.createdAt.getTime() > seen.getTime()) latest.set(matchId, r.createdAt);
  }
  return [...latest.entries()].map(([matchId, askedAt]) => ({ matchId, askedAt })).sort((a, b) => a.askedAt.getTime() - b.askedAt.getTime());
}
