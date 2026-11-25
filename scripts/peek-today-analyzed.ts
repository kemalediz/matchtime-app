import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
 const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL!})} as any);
 const start=new Date(); start.setHours(0,0,0,0);
 const rows=await db.analyzedMessage.findMany({where:{createdAt:{gte:start}},orderBy:{createdAt:"asc"}});
 console.log("count today:",rows.length);
 for(const r of rows){const t=r.createdAt.toLocaleString("en-GB",{timeZone:"Europe/London"});console.log(`[${t}] by=${r.handledBy} intent=${r.intent} author=${r.authorName??"?"} body="${(r.body??"").slice(0,70).replace(/\n/g," ")}"`);}
 await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
