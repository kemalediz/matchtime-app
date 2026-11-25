import { db } from "@/lib/db";
async function main() {
  const M = "cmtbro26i0003tt9kzarkcd8m";
  for (let i = 0; i < 60; i++) {
    const n = await db.sentNotification.count({ where: { matchId: M, key: { startsWith: `${M}:rate-dm:` } } });
    const promo = await db.sentNotification.count({ where: { key: `${M}:rate-promo` } });
    if (n >= 13 && promo >= 1) { console.log(`DRAINED: ${n} of 13 rating DMs claimed+sent, group promo posted, at ${new Date().toISOString().slice(11,19)} UTC`); return; }
    await new Promise(r => setTimeout(r, 30000));
  }
  const n = await db.sentNotification.count({ where: { matchId: M, key: { startsWith: `${M}:rate-dm:` } } });
  console.log(`NOT DRAINED after 30 min: ${n} of 13, promo ${await db.sentNotification.count({ where: { key: `${M}:rate-promo` } })}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR", e.message); process.exit(1); });
