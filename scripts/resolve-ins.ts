import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
const NAMES = ["Kemal","David","Wasim","Mujeep","Mojib","Elnur","Habib","Najib","Elvin"];
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  for (const n of NAMES) {
    const us = await db.user.findMany({
      where: { name: { contains: n, mode: "insensitive" }, memberships: { some: { orgId: org.id, leftAt: null } } },
      select: { id: true, name: true, phoneNumber: true },
    });
    console.log(`${n.padEnd(8)} -> ${us.length ? us.map((u:any)=>`${u.name} (${u.phoneNumber ?? "no phone"})`).join(" | ") : "NO MATCH"}`);
  }
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
