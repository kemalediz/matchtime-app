/** Diagnose: dashboard shows Aydın in squad #8 + Adam on bench, but
 *  Elvin's WA recap puts Adam in squad #14 + Aydın on bench. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const org = await db.organisation.findFirst({
    where: { slug: { contains: "sutton" } },
    select: { id: true },
  });
  if (!org) return console.error("no org");

  // Soonest upcoming match (today or later).
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const match = await db.match.findFirst({
    where: { activity: { orgId: org.id }, date: { gte: todayStart } },
    orderBy: { date: "asc" },
    include: { activity: { select: { name: true } } },
  });
  if (!match) return console.error("no upcoming match");
  console.log(`Match: ${match.id}  ${match.activity.name}  ${match.date.toISOString()}`);
  console.log("");

  const ats = await db.attendance.findMany({
    where: { matchId: match.id },
    include: { user: { select: { name: true, phoneNumber: true } } },
    orderBy: { createdAt: "asc" },
  });
  console.log(`Attendance rows: ${ats.length}`);
  for (const a of ats) {
    console.log(
      `  ${a.user.name?.padEnd(22) ?? "?"}  status=${a.status.padEnd(10)}  added=${a.createdAt.toISOString()}  upd=${a.updatedAt.toISOString()}  paidAt=${a.paidAt?.toISOString() ?? "-"}`,
    );
  }

  // Specifically Aydın + Adam
  console.log("");
  console.log("---focus---");
  for (const name of ["Aydın", "Adam"]) {
    const rows = ats.filter((a) =>
      a.user.name?.toLowerCase().includes(name.toLowerCase()),
    );
    for (const a of rows) {
      console.log(
        `  ${a.user.name}  status=${a.status}  createdAt=${a.createdAt.toISOString()}`,
      );
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
