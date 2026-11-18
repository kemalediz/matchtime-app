/**
 * ONE-OFF: fill "MoMAnnouncement" for Man of the Match results posted before
 * the result was stored at the claim (review of #608, 2026-11-16).
 *
 *   npx tsx scripts/backfill-mom-announcements.ts            # DRY RUN (default)
 *   npx tsx scripts/backfill-mom-announcements.ts --apply    # write
 *
 * Needs the migration 20261116120000_mom_announcement applied first.
 *
 * WHERE THE RESULT COMES FROM. Every post since 2026-10-20 stored its exact
 * words in `SentNotification.text` (key `<matchId>:mom-announcement`). That
 * text is MatchTime's own output, so it is read back by the template's
 * structure (`src/lib/mom-announcement-parse.ts`), and accepted only when our
 * builder renders the parsed result back to the very same text. Each name
 * must then be exactly one of that match's people (CONFIRMED attendance, the
 * team sheet, or a player with a vote now), by exact name.
 *
 * SKIPPED, AND LISTED: a post with no stored text (before 2026-10-20), a
 * text that does not read back exactly (cut at 1000 characters, edited, not
 * ours), a name nobody or two people at the match have, and every match that
 * already has a record. `--apply` writes the rest, with the post's own claim
 * time as "announcedAt", and NEVER overwrites a record (createMany with
 * skipDuplicates). Read-only otherwise.
 *
 * Do not run it against production without the operator's review of the dry
 * run first.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { matchMomPostToRoster, parseMomAnnouncementText } from "../src/lib/mom-announcement-parse.ts";
import { isMomAnnouncementClaimKey, type MomAnnouncedResult } from "../src/lib/mom-announce-rules.ts";

const APPLY = process.argv.includes("--apply");
const SUFFIX = ":mom-announcement";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL! }),
  } as any);

  // The posts' own claim rows only: the outbound text log's rows
  // (`txtlog:<org>:<hash>:<key>`) end with the same suffix and are not posts.
  const posts = (
    await db.sentNotification.findMany({
      where: { key: { endsWith: SUFFIX }, NOT: { key: { startsWith: "txtlog:" } } },
      select: { key: true, matchId: true, text: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    })
  ).filter((p: { key: string }) => isMomAnnouncementClaimKey(p.key));
  const existing = new Set((await db.moMAnnouncement.findMany({ select: { matchId: true } })).map((r: { matchId: string }) => r.matchId));

  const toWrite: Array<{ matchId: string; result: MomAnnouncedResult; announcedAt: Date }> = [];
  const skipped: string[] = [];
  let noText = 0;
  let already = 0;

  for (const p of posts) {
    const matchId = p.matchId ?? p.key.slice(0, -SUFFIX.length);
    if (existing.has(matchId)) {
      already++;
      continue;
    }
    if (!p.text) {
      noText++;
      continue;
    }
    const parsed = parseMomAnnouncementText(p.text);
    if (!parsed) {
      skipped.push(`${matchId}  cannot read the post back exactly: ${JSON.stringify(p.text.slice(0, 120))}`);
      continue;
    }
    const [att, teams, votes] = await Promise.all([
      db.attendance.findMany({ where: { matchId, status: "CONFIRMED" }, select: { user: { select: { id: true, name: true } } } }),
      db.teamAssignment.findMany({ where: { matchId }, select: { user: { select: { id: true, name: true } } } }),
      db.moMVote.findMany({ where: { matchId }, select: { player: { select: { id: true, name: true } } } }),
    ]);
    const byId = new Map<string, string>();
    for (const r of [...att.map((a: any) => a.user), ...teams.map((t: any) => t.user), ...votes.map((v: any) => v.player)]) {
      if (r?.name) byId.set(r.id, r.name);
    }
    const roster = [...byId].map(([userId, name]) => ({ userId, name }));
    const matched = matchMomPostToRoster(parsed, roster);
    const said =
      parsed.kind === "pick" ? `pick ${parsed.name}` : `vote ${parsed.tally.map((x) => `${x.name} ${x.votes}`).join(", ")}`;
    if (!matched.ok) {
      skipped.push(`${matchId}  ${said}  NOT MATCHED: ${matched.reason}`);
      continue;
    }
    const winners =
      matched.result.kind === "pick"
        ? matched.result.winner.name
        : (() => {
            const top = Math.max(...matched.result.tally.map((x) => x.votes));
            return matched.result.tally.filter((x) => x.votes === top).map((x) => x.name).join(" & ");
          })();
    console.log(`${matchId}  [${parsed.lang}]  winner(s): ${winners}  |  ${said}  |  every name matched`);
    toWrite.push({ matchId, result: matched.result, announcedAt: p.createdAt });
  }

  console.log("");
  console.log(`posts: ${posts.length}  already recorded: ${already}  no stored text (before 2026-10-20): ${noText}`);
  console.log(`readable and matched: ${toWrite.length}  skipped: ${skipped.length}`);
  for (const s of skipped) console.log(`  SKIP ${s}`);

  if (!APPLY) {
    console.log("\n(dry run: nothing written; pass --apply to write the matched ones)");
    await db.$disconnect();
    return;
  }
  const res = await db.moMAnnouncement.createMany({ data: toWrite as any, skipDuplicates: true });
  console.log(`\nwritten: ${res.count} (existing records are never overwritten)`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
