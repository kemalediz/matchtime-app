/**
 * How many DMs a club has had claimed since an instant (self-join slice 7,
 * cap 8: DMs to members from a new club). Read by due-posts, which holds
 * DMs over the allowance, and by the owner's /admin/clubs page.
 */
import { db } from "./db";

/**
 * Same key attribution as due-posts' group count (match-keyed, `org-<id>:`
 * keyed, and `botjob-<id>`). A released DM (the Pi's pacing) deletes its
 * row, so it does not count.
 */
export async function countOrgDmsSince(orgId: string, since: Date): Promise<number> {
  const orgBotJobs = await db.botJob.findMany({
    where: { orgId, kind: "dm", createdAt: { gte: new Date(since.getTime() - 7 * 24 * 60 * 60 * 1000) } },
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

