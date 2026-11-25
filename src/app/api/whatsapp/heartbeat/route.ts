/**
 * THE PI'S SELF-REPORT.
 *
 * The bot POSTs here on every batch-flush tick — roughly every 10
 * minutes per monitored group, INCLUDING the tick where the buffer was
 * empty and there was nothing to analyse.
 *
 * ── Why a dedicated endpoint and not a piggyback ──────────────────────
 *
 * The 2026-08-30 audit suggested sending the counters "with the existing
 * analyze POST", on the stated basis that "the bot already POSTs to
 * /api/whatsapp/analyze every 10 minutes". That is not what the bot does.
 * `flushGroup` returns early on an empty buffer (`smart-analysis.ts`) and
 * never POSTs at all — so the analyze call is conditional on there being
 * messages to send.
 *
 * Which makes the piggyback structurally unable to report the FLAGSHIP
 * failure. In August the inbound handler ran hundreds of times, every
 * message was dropped before the buffer, and every flush therefore found
 * an empty buffer and sent nothing. A counter payload attached to the
 * analyze POST would have been silent for exactly the three days it was
 * needed.
 *
 * The other candidate was `/api/whatsapp/due-posts`, which the Pi polls
 * unconditionally every 30s. Rejected on two grounds: it is a GET, so
 * counters would ride in a query string; and it is the claim-on-dispatch
 * path, the single most dangerous route in this system (the 2026-07-19
 * duplicate-send incident put 30+ copies of one post into a customer's
 * group). Adding a write to it to improve observability would be trading
 * the worst failure we have had for a better view of a lesser one.
 *
 * "A dedicated endpoint is one more thing to break" is a real objection
 * and it has a real answer: the thing that watches this endpoint watches
 * for its ABSENCE. If the heartbeat route breaks, `/api/cron/bot-health`
 * sees no fresh row and alerts. The detector for a broken detector is the
 * absence detector, and it is a separate deployment surface (a Vercel
 * cron plus Resend) from the thing being detected.
 *
 * ── This route can never cost the club a message ──────────────────────
 *
 * It writes at most one row and returns. It touches no match, no attendance, no
 * outbound queue. On the Pi side `postHeartbeat` swallows every failure,
 * so a 500 here is invisible to message delivery — which is the correct
 * relationship between a monitoring path and the thing it monitors.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { heartbeatNeedsWrite, parseHeartbeat } from "@/lib/bot-health";

const STORED_FIELDS = {
  waGroupId: true,
  lastHeartbeatAt: true,
  processStartedAt: true,
  botVersion: true,
  degradedCapabilities: true,
  seen: true,
  buffered: true,
  synthetic: true,
  reconstructed: true,
  notGroup: true,
  degradedEnrichment: true,
  nameless: true,
  reactFailures: true,
  flushFailures: true,
  droppedMessages: true,
} as const;

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = parseHeartbeat(await request.json().catch(() => null));
  if (!parsed) {
    return NextResponse.json({ error: "groupId required" }, { status: 400 });
  }

  // Unknown or disabled groups are accepted and dropped, not rejected.
  // A Pi monitoring a group that was just disabled must not start logging
  // errors about it, and an onboarding group has no org yet by design.
  // Returns ok:true so the Pi's own logs stay quiet — the server, not the
  // Pi, is the thing that decides whether a group counts.
  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: parsed.groupId },
    select: { id: true },
  });
  if (!org) return NextResponse.json({ ok: true, ignored: "unknown-group" });

  const now = new Date();

  // SKIP A HEARTBEAT THAT SAYS NOTHING NEW (Disk IO, 2026-11-25). Any
  // write forces a 16 MB WAL segment out within two minutes, and the Pi
  // reports every 10 minutes per club. A changed counter, restart, version
  // or degraded capability is still written at once; only the bare
  // liveness time waits, for at most HEARTBEAT_REFRESH_MS. See
  // `heartbeatNeedsWrite` in bot-health.ts for the margin under the alarm.
  const stored = await db.botHealth.findUnique({ where: { orgId: org.id }, select: STORED_FIELDS });
  if (
    !heartbeatNeedsWrite(
      stored,
      {
        waGroupId: parsed.groupId,
        processStartedAt: parsed.processStartedAt,
        botVersion: parsed.botVersion,
        counters: parsed.counters,
        degradedCapabilities: parsed.degradedCapabilities,
      },
      now,
    )
  ) {
    return NextResponse.json({ ok: true, unchanged: true });
  }

  const row = {
    waGroupId: parsed.groupId,
    lastHeartbeatAt: now,
    processStartedAt: parsed.processStartedAt,
    botVersion: parsed.botVersion,
    ...parsed.counters,
    degradedCapabilities: parsed.degradedCapabilities,
  };
  // Upsert, so one row per org forever. The alert-dedupe columns
  // (`lastAlertAt`, `lastAlertCodes`) are deliberately absent from both
  // halves: they belong to the cron, and a heartbeat clearing them would
  // turn "still broken" into "new fault" every ten minutes.
  await db.botHealth.upsert({
    where: { orgId: org.id },
    create: { orgId: org.id, ...row },
    update: row,
  });

  return NextResponse.json({ ok: true });
}
