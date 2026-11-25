import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { registerAttendance } from "../src/lib/attendance.ts";

/** Kieran (Wasim's friend) + Rashad (Yoobie's request). Kemal tagged
 *  "@Match Time Kieran and Rashad are IN" but the Pi's botMentioned
 *  came back false under WhatsApp @lid mentions, so the interaction-
 *  contract gate suppressed it as "untagged". Register manually as
 *  provisional guests on the next upcoming Sutton FC match. */
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
  console.log(`Target match: ${match.activity.name} ${match.date.toISOString()} max=${match.maxPlayers}`);

  for (const name of ["Kieran", "Rashad"]) {
    const existing = await db.user.findFirst({
      where: { name, memberships: { some: { orgId: org.id } } },
    });
    if (existing) {
      const r = await registerAttendance(existing.id, match.id);
      console.log(`(existing) ${name} → ${existing.id}  status=${r.status}  pos=${r.position}`);
      continue;
    }
    const user = await db.user.create({
      data: {
        name,
        email: `provisional+${name.toLowerCase()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@matchtime.local`,
        onboarded: false,
        isActive: true,
      },
    });
    await db.membership.create({
      data: { userId: user.id, orgId: org.id, role: "PLAYER", provisionallyAddedAt: new Date() },
    });
    const r = await registerAttendance(user.id, match.id);
    console.log(`Added ${name} → ${user.id}  status=${r.status}  pos=${r.position}`);
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
