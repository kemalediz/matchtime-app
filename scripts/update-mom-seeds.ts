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
 * Adjust seed ratings to reflect Man-of-the-Match poll results found in the
 * WhatsApp chat that the initial rebuild under-counted or missed entirely.
 *
 * Reasoning per player:
 *  - Idris Y: won MoM 4 Nov 2025 (5 votes). Original seed 6.5 → 7.0.
 *  - Mehmet Unal: won 2 Dec 2025 with a hat-trick by *10 votes* (huge
 *    margin). Original 7.0 undersells this → 7.5.
 *  - Ibrahim Sahin: won the latest poll (14 Apr 2026, 5 votes). Original
 *    6.0 → 6.5. (Kept modest because he's still newer to the group.)
 *  - Eren: won late-Oct 2025 MoM but left Jan 2026 and wasn't in the
 *    re-seed at all. Adding as inactive at 6.5.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const ORG_SLUG = "sutton-fc";

const BUMPS: Array<{ email: string; seedRating: number; note: string }> = [
  { email: "idris@matchday.local",       seedRating: 7.0, note: "MoM 4 Nov 2025 (5 votes)" },
  { email: "mehmet-unal@matchday.local", seedRating: 7.5, note: "MoM 2 Dec 2025 by 10 votes for hat-trick" },
  { email: "ibrahim@matchday.local",     seedRating: 6.5, note: "MoM 14 Apr 2026 (5 votes)" },
];

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const org = await db.organisation.findUnique({ where: { slug: ORG_SLUG } });
  if (!org) throw new Error(`Org ${ORG_SLUG} not found`);

  for (const b of BUMPS) {
    const user = await db.user.findUnique({ where: { email: b.email } });
    if (!user) {
      console.log(`  skip   ${b.email}  (not found)`);
      continue;
    }
    const before = user.seedRating;
    await db.user.update({
      where: { id: user.id },
      data: { seedRating: b.seedRating },
    });
    console.log(`  bump   ${(user.name ?? b.email).padEnd(22)}  ${before} → ${b.seedRating}   (${b.note})`);
  }

  // Eren wasn't in the rebuild at all. Add him as inactive.
  const erenEmail = "eren@matchday.local";
  const existingEren = await db.user.findUnique({ where: { email: erenEmail } });
  if (!existingEren) {
    const eren = await db.user.create({
      data: {
        email: erenEmail,
        name: "Eren",
        positions: ["FWD", "MID"],
        seedRating: 6.5,
        isActive: false,
        onboarded: true,
      },
    });
    await db.membership.create({
      data: { userId: eren.id, orgId: org.id, role: "PLAYER" },
    });
    console.log(`  add    Eren (inactive, FWD/MID, seed 6.5)  — MoM late Oct 2025`);
  } else {
    console.log(`  skip   Eren already exists (${existingEren.id})`);
  }

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
