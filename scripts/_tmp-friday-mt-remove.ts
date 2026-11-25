// Kemal T268 via PA, 25 Nov 2026: delete Friday MT Community matches, keep the org.
// Soft paths only: cancelMatchById (status CANCELLED, the app's cancel) and the
// activity's isActive=false (what deleteActivity does), so no new weeks are generated.
import "dotenv/config";
import { db } from "../src/lib/db";
import { cancelMatchById } from "../src/lib/match-cancel";
const MATCH = "cmwo7qtg8003y08kt5h6594bg";
const ACT = "cmv76hlvt000406l6isnlljpi";
async function main() {
  const att = await db.attendance.count({ where: { matchId: MATCH } });
  if (att > 0) throw new Error(`match has ${att} attendance rows, stopping`);
  console.log("cancel:", JSON.stringify(await cancelMatchById(MATCH)));
  const a = await db.activity.update({ where: { id: ACT }, data: { isActive: false }, select: { id: true, isActive: true } });
  console.log("activity:", JSON.stringify(a));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
