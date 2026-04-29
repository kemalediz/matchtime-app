/**
 * Why does the WhatsApp group show 57 members but the roster-survey
 * dry-run only finds 29 eligible? Drill into who's filtered out.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const org = await db.organisation.findFirst({
    where: { slug: { contains: "sutton" } },
    select: { id: true, name: true },
  });
  if (!org) return console.error("Sutton org not found");

  const all = await db.membership.findMany({
    where: { orgId: org.id },
    include: {
      user: { select: { id: true, name: true, phoneNumber: true } },
    },
  });

  const active = all.filter((m) => m.leftAt === null);
  const left = all.filter((m) => m.leftAt !== null);
  const activeWithPhone = active.filter((m) => m.user.phoneNumber);
  const activeNoPhone = active.filter((m) => !m.user.phoneNumber);

  console.log(`Total Membership rows for ${org.name}: ${all.length}`);
  console.log(`  active (leftAt=null): ${active.length}`);
  console.log(`    with phone: ${activeWithPhone.length}  ← gets DM'd by survey`);
  console.log(`    NO phone:   ${activeNoPhone.length}  ← skipped (can't DM)`);
  console.log(`  left (leftAt set):    ${left.length}`);
  console.log("");

  if (activeNoPhone.length > 0) {
    console.log("Active members WITHOUT phone (won't get DM'd):");
    for (const m of activeNoPhone) {
      console.log(
        `  ${m.user.name?.padEnd(25) ?? "(unnamed)"}  role=${m.role}  prov=${m.provisionallyAddedAt?.toISOString().slice(0, 10) ?? "-"}`,
      );
    }
    console.log("");
  }

  if (left.length > 0) {
    console.log(`Soft-removed (Membership.leftAt set) — first 10:`);
    for (const m of left.slice(0, 10)) {
      console.log(
        `  ${m.user.name?.padEnd(25) ?? "(unnamed)"}  leftAt=${m.leftAt!.toISOString().slice(0, 10)}  phone=${m.user.phoneNumber ?? "-"}`,
      );
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
