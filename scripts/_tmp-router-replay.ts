// One-off (2026-11-03): replay the Vets 09:20 22-message batch through the
// router (new code: a cut-off answer is asked again in halves). Dev key only.
// Reads AnalyzedMessage rows (read only); writes nothing.
import { db } from "../src/lib/db.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";

async function main() {
  const rows = await db.analyzedMessage.findMany({
    where: { batchId: "64b11f14-6b1b-4dd4-84c6-2df09ee7e2f7" },
    orderBy: { createdAt: "asc" },
    select: { waMessageId: true, authorName: true, body: true, authorUserId: true },
  });
  const organisers = new Set(["cmvzll43z000607iiszrhkjlj"]);
  const msgs = rows
    .filter((r) => (r.body ?? "").trim())
    .map((r) => ({
      id: r.waMessageId,
      authorName: r.authorName,
      body: r.body!,
      ...(r.authorUserId && organisers.has(r.authorUserId) ? { organisers: { context: [], senderIsOrganiser: true } } : {}),
    }));
  console.log(`messages: ${msgs.length}`);
  const inner = anthropicModel();
  let calls = 0;
  let cost = 0;
  const model: PipelineModel = {
    name: inner.name,
    async complete(req) {
      calls++;
      try {
        const r = await inner.complete(req);
        cost += r.costUsd ?? 0;
        console.log(`  call ${calls}: ok, in=${r.usage.inputTokens + r.usage.cacheReadTokens} out=${r.usage.outputTokens} $${(r.costUsd ?? 0).toFixed(5)}`);
        return r;
      } catch (err) {
        console.log(`  call ${calls}: FAILED ${(err as Error).message.slice(0, 120)}`);
        throw err;
      }
    },
  };
  const out = await routeBatch(model, msgs, { floor: false, now: new Date("2026-11-03T09:20:30Z") });
  for (const r of out.routes) {
    const m = msgs.find((x) => x.id === r.messageId)!;
    console.log(`${r.route.padEnd(10)} ${r.source ?? ""}  ${m.authorName}: ${m.body.replace(/\n/g, " | ").slice(0, 70)}`);
  }
  console.log("degradations:", out.degradations.map((d) => d.detail));
  console.log(`calls=${calls}, successful-call cost=$${cost.toFixed(5)} (a cut-off call's cost is not reported back)`);
}
main().finally(() => db.$disconnect());
