import { analyzeBatch } from "../src/lib/message-analyzer.ts";
const G="447525334985-1607872139@g.us";
const MSGS=[
  ["R1","@Match Time message all players who played in the last 5 matches to DM and invite them"],
  ["R3","@Match Time DM the recent players and invite them to Tuesday"],
  ["R4","@Match Time DM everyone who played in the last 10 matches and invite them"],
  ["R2","message all players who played in the last 5 matches to DM and invite them"],
];
async function main(){
  for(let run=1;run<=3;run++){
    console.log(`──────── run ${run} ────────`);
    for(const [id,body] of MSGS){
      const v=await analyzeBatch({groupId:G,messages:[{waMessageId:id,body,authorName:"Kemal",authorPhone:"447525334985",authorUserId:"cmn5vhtp2000004ifh4dqbsym",timestamp:new Date()}],history:[]});
      const x:any=v[0];
      console.log(`${id} recruitRequest=${x?.recruitRequest} intent=${x?.intent} conf=${x?.confidence} reply=${JSON.stringify(String(x?.reply??"").slice(0,80))}`);
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1)});
