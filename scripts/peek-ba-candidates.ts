/**
 * Why did pushname "ba" fail to resolve to Baki? Two possibilities:
 *   (1) Multiple memberships with first name starting "ba" → ambiguous
 *   (2) Phone was empty (@lid privacy) AND pushname was actually
 *       shorter/different than "ba" — provisional creation skipped
 *       because name.length < 3
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const org = await db.organisation.findFirst({
    where: { slug: { contains: "sutton", mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (!org) return;
  console.log(`Org: ${org.name}`);

  const candidates = await db.membership.findMany({
    where: { orgId: org.id },
    include: { user: { select: { id: true, name: true, phoneNumber: true } } },
  });
  console.log(`\nAll ${candidates.length} memberships in Sutton:`);
  const norm = (s: string | null) =>
    (s ?? "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const matches: typeof candidates = [];
  for (const c of candidates) {
    const firstToken = norm(c.user.name).split(/\s+/).filter(Boolean)[0] ?? "";
    const startsBa =
      firstToken === "ba" ||
      (firstToken.length >= 3 && firstToken.startsWith("ba"));
    if (startsBa) {
      matches.push(c);
      console.log(`  ★ ${c.user.name} | first=${firstToken} | phone=${c.user.phoneNumber} | leftAt=${c.leftAt}`);
    }
  }
  console.log(`\n${matches.length} candidates match pushname "ba" by fuzzy rules.`);
  if (matches.length > 1) {
    console.log("→ AMBIGUOUS — resolver returns userId=null. This is the bug.");
  }

  // Also check UserAlias for "ba".
  const alias = await db.userAlias.findUnique({
    where: { orgId_alias: { orgId: org.id, alias: "ba" } },
  });
  console.log(`\nUserAlias for "ba": ${alias ? `→ ${alias.userId}` : "(none)"}`);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
