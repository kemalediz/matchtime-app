/**
 * Print what the router and each extractor said about a message: its
 * `AnalyzedMessage.pipelineTrace` beside what the engine then decided.
 * READ-ONLY, and no model call.
 *
 *   npx tsx scripts/trace-message.ts <waMessageId or its tail>
 *
 * The tail is matched with `endsWith`, because the ids in a log line or
 * an operator note are usually clipped. Several matches are all printed,
 * newest first, capped at 5. See `src/lib/pipeline/trace.ts` for the
 * shape and why it exists.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const tail = process.argv[2]?.trim();
  if (!tail) {
    console.error("usage: npx tsx scripts/trace-message.ts <waMessageId or its tail>");
    process.exit(2);
  }
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);
  try {
    const rows = await db.analyzedMessage.findMany({
      where: { waMessageId: { endsWith: tail } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        waMessageId: true,
        createdAt: true,
        authorName: true,
        body: true,
        handledBy: true,
        intent: true,
        action: true,
        reasoning: true,
        batchId: true,
        pipelineTrace: true,
      },
    });
    if (rows.length === 0) {
      console.log(`no AnalyzedMessage whose waMessageId ends with "${tail}"`);
      return;
    }
    for (const r of rows) {
      console.log("─".repeat(72));
      console.log(`${r.waMessageId}  ${r.createdAt.toISOString()}  batch=${r.batchId ?? "-"}`);
      console.log(`${r.authorName ?? "(unknown)"}: ${(r.body ?? "").slice(0, 300)}`);
      console.log(`engine: handledBy=${r.handledBy} intent=${r.intent ?? "-"} action=${r.action ?? "-"}`);
      if (r.reasoning) console.log(`reasoning: ${r.reasoning.slice(0, 600)}`);
      console.log("pipelineTrace:");
      console.log(
        r.pipelineTrace === null
          ? "  (none: written before traces shipped, or the message never reached the router)"
          : JSON.stringify(r.pipelineTrace, null, 2),
      );
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
