/** Abid and Mojib said "In" and were registered by hand after the engine
 *  discarded their messages. Their messages carry no ✅, so from the group's
 *  side it looks like MatchTime ignored them. Queues the tick retroactively.
 *  A failed retro reaction logs and gives up; it never posts text. --apply. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
const ORG="cmnnwhdx30000zfr85q18lyy9";
const WANT=["Abid Kazmi","Mojib Jalali"];
const APPLY=process.argv.includes("--apply");
async function main(){
  const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL!})} as any);
  for(const name of WANT){
    const msg=await db.analyzedMessage.findFirst({where:{orgId:ORG,authorName:name,body:{in:["In","in","IN"]}},orderBy:{createdAt:"desc"},select:{waMessageId:true,body:true,createdAt:true}});
    if(!msg){ console.log(`${name}: no message found`); continue; }
    const t=msg.createdAt.toLocaleTimeString("en-GB",{timeZone:"Europe/London"});
    const dup=await db.retroReaction.findFirst({where:{waMessageId:msg.waMessageId,emoji:"✅"},select:{id:true,sentAt:true}});
    if(dup){ console.log(`${name}: already queued (${dup.sentAt?"sent":"pending"})`); continue; }
    if(!APPLY){ console.log(`${name}: would queue ✅ on "${msg.body}" [${t}]`); continue; }
    const r=await db.retroReaction.create({data:{orgId:ORG,waMessageId:msg.waMessageId,emoji:"✅",reason:"engine discarded the IN; registered by hand 2026-09-09"}});
    console.log(`${name}: queued ✅ on "${msg.body}" [${t}]  id=${r.id}`);
  }
  const pending=await db.retroReaction.count({where:{orgId:ORG,sentAt:null}});
  console.log(`\npending retro reactions: ${pending}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
