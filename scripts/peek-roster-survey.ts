import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const surveys = await db.rosterSurvey.findMany({
    orderBy: { createdAt: "desc" },
    take: 3,
    include: {
      org: { select: { name: true } },
      dms: { include: { user: { select: { name: true, phoneNumber: true } } } },
      responses: { include: { user: { select: { name: true } } } },
    },
  });
  for (const s of surveys) {
    console.log(`\nSurvey ${s.id}  org=${s.org.name}  status=${s.status}  created=${s.createdAt.toISOString()}`);
    console.log("  DMs:");
    for (const d of s.dms) {
      console.log(`    ${d.user.name?.padEnd(20)} phone=${d.user.phoneNumber}  botJob=${d.botJobId}  sentAt=${d.sentAt?.toISOString() ?? "-"}`);
    }
    console.log("  Responses:");
    for (const r of s.responses) {
      console.log(`    ${r.user.name?.padEnd(20)} ${r.response.padEnd(8)} adminOverride=${r.adminOverride}  classifiedAt=${r.classifiedAt.toISOString()}`);
      console.log(`      raw: ${r.rawReply.slice(0, 150)}`);
    }
  }

  console.log("\n=== Last 8 BotJobs (DM kind) ===");
  const jobs = await db.botJob.findMany({
    where: { kind: "dm" },
    orderBy: { createdAt: "desc" },
    take: 8,
  });
  for (const j of jobs.reverse()) {
    console.log(
      `  ${j.createdAt.toISOString().slice(0, 19)}  to=${j.phone}  sentAt=${j.sentAt?.toISOString().slice(0, 19) ?? "PENDING"}`,
    );
    console.log(`    ${(j.text ?? "").slice(0, 120).replace(/\n/g, " ")}`);
  }
}
main().catch(console.error).finally(() => process.exit(0));
