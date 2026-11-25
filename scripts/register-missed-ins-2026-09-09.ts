/** Abid Kazmi and Mojib Jalali both said "In" for Tue 15 Sept and were not
 *  registered: the extractor returned zero claims + affirmation=yes, so
 *  engine.ts:287 discarded them as "short confirmation with no pending set".
 *  Same word from Wasim and Habib in the same window registered fine.
 *  --apply to write. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { registerAttendance } from "../src/lib/attendance.ts";
const ADD: Array<[string,string]> = [
  ["cmo4wno9x000tmvr85cgvsira","Abid Kazmi"],
  ["cmo4wnnrd000bmvr8nujqxj49","Mojib Jalali"],
];
const APPLY=process.argv.includes("--apply");
async function main(){
  const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL!})} as any);
  const m=await db.match.findFirst({where:{activity:{orgId:"cmnnwhdx30000zfr85q18lyy9"},status:"UPCOMING"},orderBy:{date:"asc"},select:{id:true,date:true,maxPlayers:true,attendances:{select:{userId:true,status:true}}}});
  console.log(`match ${m!.date.toLocaleString("en-GB",{timeZone:"Europe/London"})} — ${m!.attendances.filter((a:any)=>a.status==="CONFIRMED").length}/${m!.maxPlayers}`);
  for(const [uid,name] of ADD){
    const ex=m!.attendances.find((a:any)=>a.userId===uid);
    if(ex){ console.log(`  SKIP ${name} — already ${ex.status}`); continue; }
    if(!APPLY){ console.log(`  would register ${name}`); continue; }
    await registerAttendance(uid, m!.id, { event:{ cause:"maintenance-script", actorKind:"script", sourceRef:"scripts/register-missed-ins-2026-09-09.ts", note:`said "In" in the group; extractor returned no claim so engine.ts:287 discarded it` } } as any);
    console.log(`  registered ${name}`);
  }
  const after=await db.attendance.count({where:{matchId:m!.id,status:"CONFIRMED"}});
  console.log(`\nnow ${after}/${m!.maxPlayers}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
