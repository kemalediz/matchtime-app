/** Quick peek at wa-sync dupes before cleanup. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const dupes = await db.user.findMany({
    where: { email: { startsWith: "wa-sync+" } },
    select: { id: true, name: true, phoneNumber: true },
  });
  console.log(`Total wa-sync dupes: ${dupes.length}`);

  const noPlus = dupes.filter((d) => d.phoneNumber && !d.phoneNumber.startsWith("+"));
  const withPlus = dupes.filter((d) => d.phoneNumber && d.phoneNumber.startsWith("+"));
  console.log(`  with no-+ phone (need fix): ${noPlus.length}`);
  console.log(`  with +-phone (already clean): ${withPlus.length}`);
  console.log("");

  let withCanonical = 0;
  let noCanonical = 0;
  for (const d of noPlus) {
    const canonical = await db.user.findUnique({
      where: { phoneNumber: `+${d.phoneNumber}` },
      select: { id: true, name: true },
    });
    if (canonical) withCanonical += 1;
    else noCanonical += 1;
  }
  console.log(`  → would merge into existing canonical: ${withCanonical}`);
  console.log(`  → no canonical (genuine new lurker): ${noCanonical}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
