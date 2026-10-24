/**
 * Former members still holding a place on an upcoming match (FNF,
 * 2026-10-24).
 *
 * Until `member-removal.ts`, removing a player (admin players page) or his
 * leaving the WhatsApp group set `Membership.leftAt` and left his
 * CONFIRMED / BENCH rows on the club's matches still to come. The squad
 * post then printed him as "a player" and "X out" could not find him
 * ("Glazers", FNF, Fri 30 Oct).
 *
 * This finds every such row and, with --apply, takes the player off
 * through the same helper the removals now call
 * (`takeRemovedMemberOffUpcomingMatches`, i.e. `cancelAttendance` with
 * cause "member-removed"), so the bench and slot rules run as on any drop
 * and nothing is said to the player. Past matches are never touched.
 *
 * DRY RUN BY DEFAULT: reads only, prints what it would do.
 *
 *   npx tsx scripts/cleanup-removed-members-upcoming.ts            # dry run, every club
 *   npx tsx scripts/cleanup-removed-members-upcoming.ts --org <id> # one club
 *   npx tsx scripts/cleanup-removed-members-upcoming.ts --apply    # write
 */
import { db } from "../src/lib/db.ts";
import { NOT_YET_PLAYED_STATUSES, takeRemovedMemberOffUpcomingMatches } from "../src/lib/member-removal.ts";

const APPLY = process.argv.includes("--apply");
const orgArg = process.argv.indexOf("--org");
const ONLY_ORG = orgArg > -1 ? process.argv[orgArg + 1] : null;

async function main() {
  const now = new Date();
  const rows = await db.attendance.findMany({
    where: {
      status: { in: ["CONFIRMED", "BENCH"] },
      match: {
        date: { gt: now },
        status: { in: [...NOT_YET_PLAYED_STATUSES] },
        ...(ONLY_ORG ? { activity: { orgId: ONLY_ORG } } : {}),
      },
    },
    select: {
      userId: true,
      status: true,
      position: true,
      user: { select: { name: true } },
      match: { select: { id: true, date: true, status: true, activity: { select: { orgId: true, org: { select: { name: true } } } } } },
    },
    orderBy: { match: { date: "asc" } },
  });

  // A row is stale when the player's membership of THAT club is closed.
  const pairs = [...new Set(rows.map((r) => `${r.userId}|${r.match.activity.orgId}`))].map((k) => k.split("|") as [string, string]);
  const mems = pairs.length
    ? await db.membership.findMany({
        where: { OR: pairs.map(([userId, orgId]) => ({ userId, orgId })) },
        select: { userId: true, orgId: true, leftAt: true },
      })
    : [];
  const leftAt = new Map(mems.map((m) => [`${m.userId}|${m.orgId}`, m.leftAt]));
  const stale = rows.filter((r) => leftAt.get(`${r.userId}|${r.match.activity.orgId}`));

  console.log(`[cleanup] ${APPLY ? "APPLY" : "DRY RUN"}${ONLY_ORG ? ` org=${ONLY_ORG}` : ""}: ${rows.length} live upcoming row(s) read, ${stale.length} held by a former member`);
  for (const r of stale) {
    const left = leftAt.get(`${r.userId}|${r.match.activity.orgId}`)!;
    console.log(
      `  ${r.match.activity.org.name} (${r.match.activity.orgId}) | match ${r.match.id} ${r.match.date.toISOString()} ${r.match.status} | ${r.user.name ?? "(no name)"} (${r.userId}) ${r.status} #${r.position} | left ${left.toISOString()}`,
    );
  }
  if (stale.length === 0 || !APPLY) {
    if (!APPLY && stale.length > 0) console.log(`\nDRY RUN: would drop ${stale.length} row(s) via cancelAttendance (cause member-removed, actor script). Re-run with --apply to write.`);
    return;
  }

  const players = [...new Set(stale.map((r) => `${r.userId}|${r.match.activity.orgId}`))].map((k) => k.split("|") as [string, string]);
  for (const [userId, orgId] of players) {
    const done = await takeRemovedMemberOffUpcomingMatches({
      userId,
      orgId,
      now,
      event: {
        cause: "member-removed",
        actorKind: "script",
        sourceRef: "scripts/cleanup-removed-members-upcoming.ts",
        note: "removed before removals took the player off upcoming matches",
      },
    });
    console.log(`  ${userId} @ ${orgId}: dropped ${done.map((d) => `${d.matchId} (${d.fromStatus})`).join(", ") || "nothing"}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
