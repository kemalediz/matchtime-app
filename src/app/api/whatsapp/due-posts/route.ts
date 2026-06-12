/**
 * The bot polls this endpoint every ~5 minutes per group. We compute every
 * WhatsApp message that's due right now (not yet sent) and return an array
 * of instructions for the bot to execute. The bot ACKs each instruction
 * via /api/whatsapp/ack so we write a SentNotification row and don't fire
 * again.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeDuePosts, sweepExpiredBenchConfirmations } from "@/lib/bot-scheduler";

export async function GET(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const groupId = searchParams.get("groupId");
  if (!groupId) {
    return NextResponse.json({ error: "groupId required" }, { status: 400 });
  }

  // Find the org first so we can run the bench-confirmation sweep scoped to
  // it. This has to happen before compute so the new prompt that replaces
  // the expired one gets posted in this same cycle.
  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId, whatsappBotEnabled: true },
    select: { id: true },
  });
  if (!org) {
    return NextResponse.json({ error: "Organisation not found / bot disabled" }, { status: 404 });
  }

  await sweepExpiredBenchConfirmations(org.id);

  // TEST-ONLY clock override (e2e suite): honour x-test-now only when the
  // server was booted with MT_TEST_MODE=1 (never set in prod). Lets tests
  // exercise time-of-day windows (rate-dm 08-10 London, rate-reminder
  // 18-19) deterministically.
  let nowOverride: Date | undefined;
  if (process.env.MT_TEST_MODE === "1") {
    const header = request.headers.get("x-test-now");
    if (header) {
      const d = new Date(header);
      if (!Number.isNaN(d.getTime())) nowOverride = d;
    }
  }

  const result = await computeDuePosts(groupId, nowOverride);
  if (!result) {
    return NextResponse.json({ instructions: [] });
  }

  return NextResponse.json(result);
}
