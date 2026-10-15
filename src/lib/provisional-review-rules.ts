/**
 * WHEN THE "NEW PLAYERS TO REVIEW" NOTICE IS DUE (2026-10-15), pure, no
 * Prisma. The text is provisional-review-copy.ts; the scheduler is
 * bot-scheduler.ts.
 *
 * The admins hear about a provisional player ONCE, when they first appear.
 * The notice used to be keyed by the day (`…:provisional-review:<who>:
 * <yyyy-MM-dd>`), so it fired again every morning about the same people
 * for as long as nobody reviewed them: twelve times in two weeks in a club
 * rehearsal, about two players an organiser had pasted in.
 *
 * Now each notice is keyed by its BATCH: the newest `provisionallyAddedAt`
 * among the players still waiting, in milliseconds
 * (`…:provisional-review:<who>:p<ms>`). Everything a notice named was added
 * at or before its marker, so the latest marker already sent is the
 * cutoff: a player added after it is new, one added before it was told.
 * A notice still on its way to some admins keeps its marker, so the cutoff
 * for it is taken from the notices BEFORE it and every admin gets the same
 * text. A day-keyed notice sent before this change counts as telling
 * everyone who was waiting when it was sent (its `createdAt`), so a club
 * already told about its waiting players gets no extra post.
 */

export function provisionalReviewKeyPrefix(orgId: string): string {
  return `org-${orgId}:provisional-review:`;
}

/** The key for one recipient (`who`: an admin's user id, or "admin-group"). */
export function provisionalReviewKey(orgId: string, who: string, newestAddedAt: Date): string {
  return `${provisionalReviewKeyPrefix(orgId)}${who}:p${newestAddedAt.getTime()}`;
}

/** A sent key's batch marker (ms), "legacy" for a day-keyed one, or null if not ours. */
export function parseProvisionalReviewKey(orgId: string, key: string): number | "legacy" | null {
  const prefix = provisionalReviewKeyPrefix(orgId);
  if (!key.startsWith(prefix)) return null;
  const last = key.slice(key.lastIndexOf(":") + 1);
  if (/^p\d+$/.test(last)) return Number(last.slice(1));
  if (/^\d{4}-\d{2}-\d{2}$/.test(last)) return "legacy";
  return null;
}

/**
 * The moment up to which the admins have been told: players added at or
 * before it were named in a notice already. Null when no notice was ever
 * sent. `legacySentAt` gives a day-keyed key's send time.
 */
export function provisionalReviewCutoff(args: {
  orgId: string;
  sentKeys: Iterable<string>;
  legacySentAt: ReadonlyMap<string, Date>;
  newestAddedAt: Date;
}): Date | null {
  const current = args.newestAddedAt.getTime();
  let cutoff: number | null = null;
  for (const key of args.sentKeys) {
    const parsed = parseProvisionalReviewKey(args.orgId, key);
    let at: number | null = null;
    if (parsed === "legacy") at = args.legacySentAt.get(key)?.getTime() ?? null;
    else if (parsed !== null && parsed !== current) at = parsed;
    if (at !== null && (cutoff === null || at > cutoff)) cutoff = at;
  }
  return cutoff === null ? null : new Date(cutoff);
}

/** Split the waiting players into those the notice names and those already told. */
export function splitProvisionalByCutoff<T extends { provisionallyAddedAt: Date | null }>(
  waiting: T[],
  cutoff: Date | null,
): { fresh: T[]; earlier: T[] } {
  const fresh: T[] = [];
  const earlier: T[] = [];
  for (const p of waiting) {
    const at = p.provisionallyAddedAt?.getTime() ?? 0;
    if (cutoff === null || at > cutoff.getTime()) fresh.push(p);
    else earlier.push(p);
  }
  return { fresh, earlier };
}
