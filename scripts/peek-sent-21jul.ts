import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
 const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL!})} as any);
 for (const id of ["cmrjvyy6b000p04jip1ges3y6","cmr9vua7i000104jveo320epn"]) {
   const m = await db.match.findUnique({where:{id}, include:{activity:{select:{name:true}}}});
   const sn = await db.sentNotification.findMany({where:{matchId:id}, orderBy:{createdAt:"asc"}});
   console.log(`\nMATCH ${id}  ${m?.activity.name}  ${m?.date.toISOString()}`);
   for(const s of sn) console.log(`   ${s.createdAt.toISOString()}  ${JSON.stringify({...s, id:undefined, matchId:undefined})}`);
   if(!sn.length) console.log("   (no sent notifications)");
 }
 await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
