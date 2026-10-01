/**
 * LAUNCH BACKFILL for badge announcements (2026-10-01). Run ONCE, after
 * the migration (prisma/migrations/20261001180000_badge_announcements)
 * and before the feature's first post, so no club hears about badges its
 * players earned long ago.
 *
 * It writes one `BadgeAnnouncement` row ("already announced") for every
 * announceable badge a player has earned, per club, at a match that
 * kicked off BEFORE the cut-off. Badges earned at or after the cut-off
 * are left out, so the first post announces them.
 *
 * Earned means under the SAME finalised view the scheduler uses
 * (`badge-announcements.ts`): a match's MoM vote and ratings count only
 * once its MoM result has been posted, or it is past the point where one
 * ever could be. So a provisional MoM leader is NOT recorded here; if he
 * wins, the post after his match's result announces it.
 *
 * Each row's `matchId` is the match at which the badge was first earned,
 * from a per-match replay of the rules (`replayBadges`).
 *
 * ── Running it ───────────────────────────────────────────────────────
 *
 *   npx tsx scripts/backfill-badge-announcements.ts                      # dry run, everything earned counts as announced
 *   npx tsx scripts/backfill-badge-announcements.ts --from 2026-09-22    # dry run, leave badges from 22 Sept on for the first post
 *   npx tsx scripts/backfill-badge-announcements.ts --from 2026-09-22 --apply
 *   ... --org <orgId>                                                    # one club only
 *
 * `--from` is the London date of the FIRST match whose badges may still
 * be announced. Without it, everything already earned is recorded.
 *
 * DRY RUN BY DEFAULT: prints, per club, what it would record and what the
 * first post would say if it went out now (the real post goes out at
 * 18:00 London two days after the match, by when more results may be
 * final). Writes nothing without --apply. Idempotent: rows already in the
 * ledger are skipped, and the insert itself skips duplicates.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { formatLondon, londonDateTimeToUtc } from "../src/lib/london-time.ts";
import {
  announcedKey,
  badgeMatchFinalised,
  buildBadgeAnnouncementPost,
  entriesFor,
  pickBadgeAwards,
  replayBadges,
  selectBackfillRows,
  toReplayMatches,
} from "../src/lib/badge-announcements.ts";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const fromArg = argValue("--from");
  const onlyOrg = argValue("--org");
  if (fromArg !== null && !/^\d{4}-\d{2}-\d{2}$/.test(fromArg)) {
    throw new Error(`--from must be a London date, YYYY-MM-DD (got ${JSON.stringify(fromArg)})`);
  }
  const from = fromArg ? londonDateTimeToUtc(fromArg, "00:00") : null;
  const now = new Date();

  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  console.log(
    `${apply ? "APPLY" : "DRY RUN"}: ${from ? `badges earned before ${fromArg} (London) are recorded as announced` : "every badge already earned is recorded as announced"}\n`,
  );

  const orgs = await db.organisation.findMany({
    where: onlyOrg ? { id: onlyOrg } : {},
    select: { id: true, name: true, language: true, featureBadgeAnnouncements: true },
    orderBy: { name: "asc" },
  });

  let total = 0;
  for (const org of orgs) {
    const rows = await db.match.findMany({
      where: { activity: { orgId: org.id }, status: "COMPLETED", isHistorical: false },
      orderBy: { date: "asc" },
      select: {
        id: true,
        date: true,
        ratings: { select: { playerId: true, score: true } },
        momVotes: { select: { playerId: true } },
        teamAssignments: { select: { userId: true } },
        attendances: { where: { status: "CONFIRMED" }, select: { userId: true } },
      },
    });
    if (rows.length === 0) continue;
    const raw = rows.map((m) => ({
      id: m.id,
      date: m.date,
      confirmed: m.attendances.map((a) => a.userId),
      teamUserIds: m.teamAssignments.map((t) => t.userId),
      ratings: m.ratings,
      momVotes: m.momVotes,
    }));

    const [sent, members, ledger] = await Promise.all([
      db.sentNotification.findMany({
        where: { key: { in: raw.map((m) => `${m.id}:mom-announcement`) } },
        select: { key: true },
      }),
      db.membership.findMany({
        where: { orgId: org.id },
        select: { leftAt: true, user: { select: { id: true, name: true } } },
      }),
      db.badgeAnnouncement.findMany({ where: { orgId: org.id }, select: { userId: true, badgeKey: true } }),
    ]);
    const sentKeys = new Set(sent.map((s) => s.key));
    const nameById = new Map<string, string>();
    const current = new Map<string, string>();
    for (const m of members) {
      const name = m.user.name?.trim() || m.user.id;
      nameById.set(m.user.id, name);
      if (m.leftAt === null && m.user.name?.trim()) current.set(m.user.id, m.user.name.trim());
    }
    const announced = new Set(ledger.map((r) => announcedKey(r.userId, r.badgeKey)));

    const replay = replayBadges(toReplayMatches(raw, (m) => badgeMatchFinalised(m, sentKeys, now)));
    const dateById = new Map(raw.map((m) => [m.id, m.date]));
    const toRecord = selectBackfillRows({ replay, matchDateById: dateById, from, announced });

    console.log(
      `── ${org.name} (${org.id})${org.featureBadgeAnnouncements ? "" : " [announcements OFF]"}: ` +
        `${raw.length} completed matches, ${ledger.length} ledger rows already, ${toRecord.length} to record`,
    );
    for (const r of toRecord) {
      const d = dateById.get(r.matchId);
      console.log(`   record  ${nameById.get(r.userId) ?? r.userId}: ${r.badgeKey} (earned ${d ? formatLondon(d, "d MMM yyyy") : r.matchId})`);
    }

    // What the first post would carry if it went out now.
    const after = new Set([...announced, ...toRecord.map((r) => announcedKey(r.userId, r.badgeKey))]);
    const last = raw[raw.length - 1];
    const { awards } = pickBadgeAwards({
      replay,
      matchId: last.id,
      announced: after,
      bootstrap: after.size === 0,
      eligibleUserIds: new Set(current.keys()),
    });
    const text = buildBadgeAnnouncementPost(entriesFor(awards, current), org.language);
    console.log(
      `   first post (for ${formatLondon(last.date, "d MMM")}, if it went out now): ` +
        (text ? `\n${text.split("\n").map((l) => `      | ${l}`).join("\n")}` : "nothing to announce"),
    );
    console.log("");

    if (apply && toRecord.length > 0) {
      const res = await db.badgeAnnouncement.createMany({
        data: toRecord.map((r) => ({ orgId: org.id, userId: r.userId, badgeKey: r.badgeKey, matchId: r.matchId })),
        skipDuplicates: true,
      });
      console.log(`   wrote ${res.count} row(s)\n`);
    }
    total += toRecord.length;
  }

  console.log(`${apply ? "Recorded" : "Would record"} ${total} badge(s) across ${orgs.length} club(s).`);
  if (!apply) console.log("Dry run: nothing written. Re-run with --apply to write.");
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
