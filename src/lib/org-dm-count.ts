/**
 * How many DMs a club has had claimed since an instant (self-join slice 7,
 * cap 8: DMs to members from a new club). Read by due-posts, which holds
 * DMs over the allowance, and by the owner's /admin/clubs page.
 */
import { db } from "./db";
import { BOTJOB_PRIORITY_DEFAULT } from "./dm-reply-priority";

/**
 * Same key attribution as due-posts' group count (match-keyed, `org-<id>:`
 * keyed, and `botjob-<id>`). A released DM (the Pi's pacing) deletes its
 * row, so it does not count.
 *
 * `excludeReplies` (DM_REPLY_PRIORITY_ENABLED on only,
 * src/lib/dm-reply-priority.ts): a BotJob reply (priority 1) is not
 * attributed to the club, so it does not count toward the new-club cap.
 * Its key is `botjob-<id>`, never match- or `org-`-keyed, so leaving it
 * out of the id list is enough. Omitted or false: today's query exactly.
 */
export async function countOrgDmsSince(
  orgId: string,
  since: Date,
  opts: { excludeReplies?: boolean } = {},
): Promise<number> {
  const orgBotJobs = await db.botJob.findMany({
    where: {
      orgId,
      kind: "dm",
      createdAt: { gte: new Date(since.getTime() - 7 * 24 * 60 * 60 * 1000) },
      ...(opts.excludeReplies ? { priority: BOTJOB_PRIORITY_DEFAULT } : {}),
    },
    select: { id: true },
    take: 500,
  });
  const botJobKeys = orgBotJobs.map((j) => `botjob-${j.id}`);
  return db.sentNotification.count({
    where: {
      createdAt: { gte: since },
      kind: "dm",
      OR: [
        { match: { activity: { orgId } } },
        { key: { startsWith: `org-${orgId}:` } },
        ...(botJobKeys.length ? [{ key: { in: botJobKeys } }] : []),
      ],
    },
  });
}

