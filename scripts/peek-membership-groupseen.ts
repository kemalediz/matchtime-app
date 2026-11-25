import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
 const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL!})} as any);
 const org=await db.organisation.findFirst({where:{slug:"sutton-fc"}});
 const ms=await db.membership.findMany({where:{orgId:org!.id, leftAt:null}, include:{user:{select:{name:true,phoneNumber:true,onboarded:true}}}});
 let seen=0, notseen=0, provisional=0;
 const notSeenNames:string[]=[];
 for(const m of ms){
   if(m.provisionallyAddedAt) provisional++;
   if(m.lastSeenInGroupAt) seen++; else { notseen++; notSeenNames.push(`${m.user.name??"?"}${m.user.phoneNumber?"":" (no phone)"}${m.provisionallyAddedAt?" [provisional]":""}`); }
 }
 console.log(`Active memberships: ${ms.length}`);
 console.log(`  lastSeenInGroupAt set (would PASS gate): ${seen}`);
 console.log(`  lastSeenInGroupAt NULL (would be BLOCKED): ${notseen}  (${provisional} of these are provisional guests)`);
 console.log(`\nNULL (blocked) members:`);
 notSeenNames.forEach(n=>console.log("  - "+n));
 await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
