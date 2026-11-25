import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { registerAttendance } from "../src/lib/attendance.ts";

const APPLY = process.argv.includes("--apply");

async function rosterLines(db: any, matchId: string) {
  const confirmed = await db.attendance.findMany({
    where: { matchId, status: "CONFIRMED" },
    include: { user: { select: { name: true } } },
    orderBy: { position: "asc" },
  });
  return confirmed.map((a: any, i: number) => `${i + 1}. ${a.user.name ?? "?"}`);
}

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  if (!org) throw new Error("no sutton-fc org");
  const match = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      isHistorical: false,
    },
    include: { activity: { include: { sport: true } } },
    orderBy: { date: "asc" },
  });
  if (!match) throw new Error("no upcoming match");
  console.log(`Match: ${match.activity.name}  max=${match.maxPlayers}`);

  if (APPLY) {
    const existing = await db.user.findFirst({
      where: { name: "Ayoub", memberships: { some: { orgId: org.id } } },
    });
    if (existing) {
      const r = await registerAttendance(existing.id, match.id);
      console.log(`(existing) Ayoub → ${existing.id} status=${r.status} pos=${r.position}`);
    } else {
      const user = await db.user.create({
        data: {
          name: "Ayoub",
          email: `provisional+ayoub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@matchtime.local`,
          onboarded: false,
          isActive: true,
        },
      });
      await db.membership.create({
        data: { userId: user.id, orgId: org.id, role: "PLAYER", provisionallyAddedAt: new Date() },
      });
      const r = await registerAttendance(user.id, match.id);
      console.log(`Added Ayoub → ${user.id} status=${r.status} pos=${r.position}`);
    }
  }

  const lines = await rosterLines(db, match.id);
  const count = lines.length;
  const dryCount = APPLY ? count : count + 1; // dry-run simulates Ayoub added
  const dryLines = APPLY ? lines : [...lines, `${count + 1}. Ayoub`];

  const text =
    `✅ *Squad update* — correcting my earlier count (that 10/14 was wrong, apologies 🙏).\n\n` +
    `We're now *${dryCount}/${match.maxPlayers}* for tomorrow's *${match.activity.name}*, with *Kieran*, *Rashad* and *Ayoub* added 🙌\n\n` +
    `*Playing (${dryCount}/${match.maxPlayers}):*\n${dryLines.join("\n")}\n\n` +
    `Just *${match.maxPlayers - dryCount} spot${match.maxPlayers - dryCount === 1 ? "" : "s"} left* — reply *IN* to grab it.`;

  console.log("\n--- MESSAGE ---\n" + text + "\n---------------\n");

  if (!APPLY) {
    console.log("(dry-run — pass --apply to add Ayoub AND queue the group message)");
    await db.$disconnect();
    return;
  }

  const job = await db.botJob.create({ data: { orgId: org.id, kind: "group", text } });
  console.log(`Queued BotJob ${job.id} — posts on the next bot cycle (≤5 min).`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
