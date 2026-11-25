/* Sandbox timeline: poll due-posts every STEP minutes from START to END,
 * ACK every dispatched instruction like the Pi does. Sandbox DB only. */
const [START, END, STEP] = [process.argv[2], process.argv[3], Number(process.argv[4] ?? 15)];
if (!process.env.DATABASE_URL?.includes("127.0.0.1:55871")) throw new Error("not the sandbox DB");
process.env.MT_TEST_MODE = "1";
process.env.WHATSAPP_API_KEY = "preview-key";
process.env.ANTHROPIC_API_KEY = "";
process.env.AUTH_SECRET = "preview-dummy-secret-not-prod-0123456789abcdef";
delete process.env.NEXTAUTH_URL;
const external: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  external.push(u);
  throw new Error(`[preview] blocked outbound fetch: ${u}`);
}) as typeof fetch;
async function main() {
  const { GET } = await import("../src/app/api/whatsapp/due-posts/route");
  const { POST: ACK } = await import("../src/app/api/whatsapp/ack/route");
  const { db } = await import("../src/lib/db");
  let n = 0;
  const TBLS = ["SentNotification", "BotJob", "BenchSlotOffer"];
  for (const tbl of TBLS) await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "_seen_${tbl}" AS SELECT id FROM "${tbl}"`);
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "_seen_sent" AS SELECT id FROM "BotJob" WHERE "sentAt" IS NOT NULL`);
  for (let t = new Date(START).getTime(); t <= new Date(END).getTime(); t += STEP * 60000) {
    const iso = new Date(t).toISOString();
    const res = await GET(new Request(`http://localhost/api/whatsapp/due-posts?groupId=${encodeURIComponent("120363418762991368@g.us")}`, {
      headers: { "x-api-key": "preview-key", "x-test-now": iso, "x-mt-platform-jobs": "1", "x-mt-pi-caps": "admin-group,quoted-id" },
    }));
    const body = (await res.json()) as { instructions?: Array<Record<string, unknown>> };
    const ins = body.instructions ?? [];
    if (res.status !== 200) console.log(`===POLL ${iso} status=${res.status}`);
    if (ins.length) {
      console.log(`===POLL ${iso} (${ins.length})`);
      for (const i of ins) {
        console.log(JSON.stringify(i));
        await ACK(new Request("http://localhost/api/whatsapp/ack", {
          method: "POST",
          headers: { "x-api-key": "preview-key", "content-type": "application/json" },
          body: JSON.stringify({ key: i.key, kind: i.kind, matchId: i.matchId, targetUser: i.targetUser, waMessageId: `PREVIEW_${++n}` }),
        }));
      }
    }
    // Rows this poll wrote carry the REAL clock; move them to the simulated
    // time so later polls see them as the live system would.
    const ts = iso.replace("Z", "");
    for (const tbl of TBLS) {
      await db.$executeRawUnsafe(`UPDATE "${tbl}" SET "createdAt" = $1::timestamp WHERE id NOT IN (SELECT id FROM "_seen_${tbl}")`, ts);
      await db.$executeRawUnsafe(`INSERT INTO "_seen_${tbl}" SELECT id FROM "${tbl}" WHERE id NOT IN (SELECT id FROM "_seen_${tbl}")`);
    }
    await db.$executeRawUnsafe(`UPDATE "BotJob" SET "sentAt" = $1::timestamp WHERE "sentAt" IS NOT NULL AND id NOT IN (SELECT id FROM "_seen_sent")`, ts);
    await db.$executeRawUnsafe(`INSERT INTO "_seen_sent" SELECT id FROM "BotJob" WHERE "sentAt" IS NOT NULL AND id NOT IN (SELECT id FROM "_seen_sent")`);
  }
  console.log(`===EXTERNAL_FETCHES ${JSON.stringify(external)}`);
  process.exit(0);
}
main().catch((e) => { console.error("RUNNER FAILED", e); process.exit(1); });
