/**
 * SPENT, AND NO LONGER RUNNABLE. This script reads or writes
 * `User.seedRating` / `User.matchRating`, and both columns were DROPPED
 * on 2026-09-19 (slice 7 of
 * MDs/club-scoped-ratings-design-2026-09-18.md). It will throw.
 *
 * Kept as a record of what was done, not as something to re-run or copy.
 * The seed and the Elo are per club now: `Membership.seedRating`, and
 * `src/lib/membership-elo.ts` for the Elo, which needs the match's org.
 */
/**
 * Rebuild Sutton FC data from WhatsApp chat analysis.
 *
 * Preserves:
 *   - The Org row (so its id, inviteCode, bot config stay valid)
 *   - The 2 Activity rows (cron jobs reference them)
 *   - The real Google-OAuth user kemal.ediz@cressoft.io (keeps the Account linkage intact)
 *
 * Wipes:
 *   - All other User rows (cascades through Membership, Attendance, Rating, MoMVote, TeamAssignment)
 *   - Any existing matches (0 today, but cascade-safe)
 *
 * Re-seeds:
 *   - ~28 current regulars as @matchday.local placeholders with positions + seedRating
 *   - Kemal as OWNER of Sutton FC; everyone else PLAYER
 *
 * Source: /tmp/sutton-new/chat.txt analysis (Nov 2022 – 18 Apr 2026).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const OWNER_EMAIL = "kemal.ediz@cressoft.io";
const ORG_SLUG = "sutton-fc";

/**
 * Player roster from chat analysis. Positions in preference order.
 * seedRating reflects: MoM wins, explicit praise, scoring signals, tenure.
 * `active` = appeared in Jan–Apr 2026 lineups.
 */
const PLAYERS: Array<{
  slug: string;
  name: string;
  positions: ("GK" | "DEF" | "MID" | "FWD")[];
  seedRating: number;
  active: boolean;
  note?: string;
}> = [
  // --- Admin / Organisers ---
  { slug: "sait",        name: "Sait",            positions: ["MID"],        seedRating: 6.5, active: true, note: "Co-organiser, admin since Jan 2026" },
  { slug: "elvin",       name: "Elvin Azeri",     positions: ["MID", "FWD"], seedRating: 7.0, active: true, note: "Co-organiser, MoM 22 Oct 2025" },
  { slug: "baki",        name: "Baki Sutton",     positions: ["MID", "FWD"], seedRating: 7.0, active: true, note: "Trophy/logistics, praised scorer" },

  // --- Core regulars (high seed, frequent MoM signal) ---
  { slug: "wasim",       name: "Wasim",           positions: ["MID", "FWD"], seedRating: 7.0, active: true, note: "MoM 3 Feb 2026, flexible" },
  { slug: "ersin",       name: "Ersin Sevindik",  positions: ["GK"],         seedRating: 7.0, active: true, note: "MoM (GK) 10 Feb 2026, 7 votes" },
  { slug: "mojib",       name: "Mojib",           positions: ["MID", "DEF"], seedRating: 6.5, active: true, note: "Co-MoM 3 Feb 2026, MoM 16 Dec 2025" },
  { slug: "ehtisham",    name: "Ehtisham Ul Haq", positions: ["MID"],        seedRating: 6.5, active: true, note: "MoM-2 Feb 2026" },
  { slug: "ali",         name: "Ali",             positions: ["DEF"],        seedRating: 6.5, active: true, note: "MoM 16 Dec 2025" },
  { slug: "idris",       name: "Idris Y",         positions: ["DEF"],        seedRating: 6.5, active: true, note: "Very consistent defender" },
  { slug: "mustafa",     name: "Mustafa Cayir",   positions: ["MID", "FWD"], seedRating: 6.5, active: true },
  { slug: "aytekin",     name: "Aytekin Y",       positions: ["DEF"],        seedRating: 6.5, active: true, note: "Strong defender" },
  { slug: "zair",        name: "Zair",            positions: ["FWD"],        seedRating: 6.5, active: true, note: "MoM 14 Nov 2025 (forward)" },

  // --- Regulars (mid seed) ---
  { slug: "elnur",       name: "Elnur Mammadov",  positions: ["MID", "FWD"], seedRating: 6.0, active: true },
  { slug: "omar",        name: "Omar",            positions: ["MID", "GK"],  seedRating: 6.0, active: true, note: "Emergency keeper" },
  { slug: "abid",        name: "Abid Kazmi",      positions: ["MID"],        seedRating: 6.0, active: true },
  { slug: "ilkay",       name: "Ilkay",           positions: ["MID", "FWD"], seedRating: 6.0, active: true },
  { slug: "mauricio",    name: "Mauricio",        positions: ["MID"],        seedRating: 6.0, active: true },
  { slug: "enayem",      name: "Enayem",          positions: ["MID"],        seedRating: 6.0, active: true },
  { slug: "fatih",       name: "Fatih Incefidan", positions: ["DEF"],        seedRating: 6.0, active: true },
  { slug: "ibrahim",     name: "Ibrahim Sahin",   positions: ["MID"],        seedRating: 6.0, active: true, note: "MoM candidate Apr 2026" },
  { slug: "amir",        name: "Amir",            positions: ["MID"],        seedRating: 6.0, active: true },
  { slug: "najib",       name: "Najib",           positions: ["MID", "DEF"], seedRating: 5.5, active: true, note: "Bench/occasional" },

  // --- Occasional / historical high-impact (left or sporadic) ---
  { slug: "hasan",       name: "Hasan Altun",     positions: ["DEF", "MID"], seedRating: 6.5, active: false, note: "Early organiser, quieter 2026" },
  { slug: "erdal",       name: "Erdal",           positions: ["FWD", "MID"], seedRating: 7.0, active: false, note: "MoM 19 Nov 2024, midfield scorer" },
  { slug: "mehmet-unal", name: "Mehmet Unal",     positions: ["MID", "FWD"], seedRating: 7.0, active: false, note: "Hat-trick scorer" },
  { slug: "aykut",       name: "Aykut Arsoy",     positions: ["MID", "FWD"], seedRating: 7.5, active: false, note: "Hat-trick / 8 goals in one game" },
  { slug: "ersan",       name: "Ersan Arik",      positions: ["FWD", "MID"], seedRating: 6.5, active: false, note: "Right wing, MoM candidate Oct 2025" },
  { slug: "burak",       name: "Burak Yildiz",    positions: ["FWD", "MID"], seedRating: 6.0, active: false },
  { slug: "yusuf",       name: "Yusuf Erdogan",   positions: ["MID"],        seedRating: 6.0, active: false },
  { slug: "akin",        name: "Akin Keypoint",   positions: ["GK"],         seedRating: 7.0, active: false, note: "Semi-pro quality keeper" },
  { slug: "recai",       name: "Recai Gunay",     positions: ["MID", "FWD"], seedRating: 6.0, active: false, note: "Early regular, quieter mid-2024+" },
  { slug: "michael",     name: "Michael Allen",   positions: ["MID", "FWD"], seedRating: 6.0, active: false },
];

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  // 1. Find the org and the real owner.
  const org = await db.organisation.findUnique({ where: { slug: ORG_SLUG } });
  if (!org) throw new Error(`Org with slug '${ORG_SLUG}' not found — aborting rebuild`);

  const owner = await db.user.findUnique({ where: { email: OWNER_EMAIL } });
  if (!owner) throw new Error(`Owner '${OWNER_EMAIL}' not found — aborting rebuild`);

  console.log(`Org: ${org.name} (${org.id})`);
  console.log(`Owner: ${owner.name ?? "(no name)"} <${owner.email}> (${owner.id})`);

  // 2. Wipe match-related data first (FKs to User don't all cascade).
  const delAtt  = await db.attendance.deleteMany({});
  const delRat  = await db.rating.deleteMany({});
  const delMom  = await db.moMVote.deleteMany({});
  const delTA   = await db.teamAssignment.deleteMany({});
  const delMatch = await db.match.deleteMany({});
  console.log(`Cleared match data: attendances=${delAtt.count} ratings=${delRat.count} mom=${delMom.count} teamAssignments=${delTA.count} matches=${delMatch.count}`);

  // 3. Wipe every non-owner user (Account/Session/Membership cascade from User).
  const deleted = await db.user.deleteMany({ where: { email: { not: OWNER_EMAIL } } });
  console.log(`Deleted ${deleted.count} non-owner users`);

  // 3. Promote owner to OWNER on this org (upsert — safe to re-run).
  await db.membership.upsert({
    where: { userId_orgId: { userId: owner.id, orgId: org.id } },
    create: { userId: owner.id, orgId: org.id, role: "OWNER" },
    update: { role: "OWNER" },
  });

  // Refine owner's own profile based on chat analysis (frequent GK/MID, recent MoM winner).
  await db.user.update({
    where: { id: owner.id },
    data: {
      name: owner.name ?? "Kemal Ediz",
      positions: ["GK", "MID"],
      seedRating: 7.0,
      onboarded: true,
      isActive: true,
    },
  });
  console.log(`Promoted ${OWNER_EMAIL} to OWNER of ${org.slug} with refined profile`);

  // 4. Re-seed players.
  let createdCount = 0;
  for (const p of PLAYERS) {
    const email = `${p.slug}@matchday.local`;
    const user = await db.user.create({
      data: {
        email,
        name: p.name,
        positions: p.positions,
        seedRating: p.seedRating,
        isActive: p.active,
        onboarded: true,
      },
    });
    await db.membership.create({
      data: { userId: user.id, orgId: org.id, role: "PLAYER" },
    });
    createdCount++;
    console.log(`  + ${p.active ? "active  " : "inactive"}  ${p.name.padEnd(22)} ${p.positions.join("/").padEnd(10)} seed=${p.seedRating}  ${p.note ? `(${p.note})` : ""}`);
  }
  console.log(`\nCreated ${createdCount} player rows.`);

  // 5. Verify final state.
  const finalUsers = await db.user.count();
  const finalMemberships = await db.membership.count({ where: { orgId: org.id } });
  const ownerMembership = await db.membership.findFirst({
    where: { userId: owner.id, orgId: org.id },
    select: { role: true },
  });

  console.log(`\nFinal: ${finalUsers} users, ${finalMemberships} memberships on ${org.slug}, owner role=${ownerMembership?.role}`);

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
