/**
 * THE HALF THAT NOTICES ABSENCE.
 *
 * A heartbeat driven by the Pi can only report failures the Pi survives.
 * The failures that cost the most (a crashed process, an unplugged Pi, a
 * dead SD card, a revoked WhatsApp session, an expired API key, a router
 * that came back on a different subnet) all have the same signature:
 * the Pi sends NOTHING. Nothing is not a message anybody receives. So
 * something that is not the Pi has to go looking, on a clock of its own.
 *
 * That is this route. Hourly, from `vercel.json`, over every org with the
 * bot enabled:
 *
 *   1. gather what the server already knows (last analysed message, last
 *      participant sweep, next fixture, unattributable senders) plus the
 *      Pi's latest self-report from `BotHealth`,
 *   2. hand all of it to `assessBotHealth`: pure, unit-tested, and where
 *      every threshold and every false-alarm guard is argued,
 *   3. RECORD the result as `OpsAlert` rows (`src/lib/ops-alerts.ts`):
 *      a condition opens a row, keeps it open while it holds, and closes
 *      it when it stops. The owner reads them at /admin/health.
 *
 * ── It sends nothing (2026-09-28) ─────────────────────────────────────
 *
 * From 2026-09-09 this route emailed the owner and queued WhatsApp DMs to
 * the club's admins, first every six hours and then once a day. Kemal:
 * "remove these daily messages... Also remove these daily emails... Only
 * put them into a dashboard on the website where i can click and see
 * whenever i want." No email, no `BotJob`. The only thing it writes is
 * `OpsAlert` rows.
 *
 * NOTE on the one case that might seem to deserve a message: a bot that
 * is unpaired or dead. A WhatsApp DM cannot report that, because the DM
 * would be delivered by the very bot that is down; only an email could,
 * and the owner asked for the emails to stop too. So nothing is kept.
 *
 * This route never writes to a match, an attendance, or the outbound
 * queue. It cannot make an outage worse.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { servingClubWhere } from "@/lib/club-approval";
import { assessBotHealth, type HealthCounters, type HeartbeatSnapshot } from "@/lib/bot-health";
import { HEALTH_KIND_PREFIX, recordHealthFindings } from "@/lib/ops-alerts";
import { isNoneBucketShadowEnabled } from "@/lib/pipeline/gate";
import { NONE_SHADOW_BATCH_PREFIX } from "@/lib/pipeline/none-shadow";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // TEST-ONLY clock override (e2e suite), gated on MT_TEST_MODE=1 exactly
  // like /api/whatsapp/due-posts and never set in prod. Every rule here is
  // a comparison against "now", so the specs pin it.
  let now = new Date();
  if (process.env.MT_TEST_MODE === "1") {
    const pinned = new Date(request.headers.get("x-test-now") ?? "");
    if (!Number.isNaN(pinned.getTime())) now = pinned;
  }
  const orgs = await db.organisation.findMany({
    where: { ...servingClubWhere(), whatsappBotEnabled: true, whatsappGroupId: { not: null } },
    // `lastParticipantSweepAt` is the sweep's own clock (2026-09-09). It
    // replaces the `MAX(Membership.lastSeenInGroupAt)` aggregate that used
    // to be in the Promise.all below: a group message now refreshes the
    // sender's sighting, so that MAX no longer measures the sweep and
    // `sweep-stale` would have stopped firing on a live outage.
    select: { id: true, name: true, lastParticipantSweepAt: true },
  });

  const report: Array<{
    org: string;
    codes: string[];
    /** Rows opened, refreshed and closed this tick; null if the write failed. */
    recorded: { opened: number; refreshed: number; closed: number } | null;
  }> = [];

  for (const org of orgs) {
    try {
      const [health, lastMsg, nextMatch, nameless, lastShadow] = await Promise.all([
        db.botHealth.findUnique({ where: { orgId: org.id } }),
        db.analyzedMessage.findFirst({
          where: { orgId: org.id },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
        db.match.findFirst({
          where: {
            activity: { orgId: org.id },
            date: { gt: now },
            status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
          },
          orderBy: { date: "asc" },
          select: { date: true },
        }),
        // The attribution hole, counted server-side so it is visible even
        // from a Pi build that sends no heartbeat at all. Neither a user
        // nor a name means nobody could be resolved and any attendance in
        // the message was silently not written.
        db.analyzedMessage.count({
          where: {
            orgId: org.id,
            authorUserId: null,
            authorName: null,
            createdAt: { gte: new Date(now.getTime() - DAY_MS) },
          },
        }),
        // The nightly `none`-bucket sweep's heartbeat. It files a
        // `WindowVerdict` every night whether or not it found anything
        // (since 2026-09-11), so the ABSENCE of a recent row is the only
        // evidence that the one thing watching the `none` bucket has
        // stopped. `windowEnd` rather than `createdAt`: a same-day re-run
        // upserts the day's row, which moves `windowEnd` and leaves
        // `createdAt` at the first run, and "when did it last run" is
        // the question being asked. Served by the existing
        // `[orgId, windowEnd]` index.
        db.windowVerdict.findFirst({
          where: { orgId: org.id, batchHash: { startsWith: NONE_SHADOW_BATCH_PREFIX } },
          orderBy: { windowEnd: "desc" },
          select: { windowEnd: true },
        }),
      ]);

      // `lastHeartbeatAt === null` means no heartbeat has ever arrived —
      // a healthy Pi on an older build, or an org whose row exists only
      // because a server-side rule alerted on it. Either way there are no
      // counters to reason about, so the snapshot is null and every
      // heartbeat-derived rule stays silent. See the note in
      // `assessBotHealth` on why that asymmetry is deliberate.
      const heartbeat: HeartbeatSnapshot | null = health?.lastHeartbeatAt
        ? {
            at: health.lastHeartbeatAt,
            processStartedAt: health.processStartedAt,
            counters: {
              seen: health.seen,
              buffered: health.buffered,
              synthetic: health.synthetic,
              reconstructed: health.reconstructed,
              notGroup: health.notGroup,
              degradedEnrichment: health.degradedEnrichment,
              nameless: health.nameless,
              reactFailures: health.reactFailures,
              flushFailures: health.flushFailures,
              droppedMessages: health.droppedMessages,
            } satisfies HealthCounters,
            degradedCapabilities: health.degradedCapabilities,
          }
        : null;

      const findings = assessBotHealth({
        orgName: org.name,
        now,
        botEnabled: true,
        heartbeat,
        lastAnalyzedMessageAt: lastMsg?.createdAt ?? null,
        lastParticipantSweepAt: org.lastParticipantSweepAt ?? null,
        nextMatchAt: nextMatch?.date ?? null,
        namelessUnattributed24h: nameless,
        // Read from the env, because the flag IS the env var. With it
        // off the rule stays silent: a nightly job nobody turned on is a
        // decision, not an outage, and an hourly page about one would be
        // the noise that gets this whole channel muted.
        noneShadowEnabled: isNoneBucketShadowEnabled(),
        lastNoneShadowAt: lastShadow?.windowEnd ?? null,
      });
      const plan = await recordHealthFindings(org.id, findings, now);
      report.push({
        org: org.name,
        codes: findings.map((f) => f.code),
        recorded: plan
          ? { opened: plan.create.length, refreshed: plan.update.length, closed: plan.resolve.length }
          : null,
      });
    } catch (err) {
      // One org's bad data must never stop the sweep reaching the next
      // org. A monitoring job that dies on the first exception is a
      // monitoring job that reports nothing.
      console.error(`[bot-health] assessment failed for ${org.name}:`, err);
      report.push({ org: org.name, codes: [], recorded: null });
    }
  }

  // A club whose bot was switched off (or whose group was unlinked) is
  // not assessed any more, so nothing above would ever close its rows.
  // Close them here: off is not broken, and a club that is gone must not
  // sit red on the owner's page forever.
  try {
    await db.opsAlert.updateMany({
      where: {
        resolvedAt: null,
        kind: { startsWith: HEALTH_KIND_PREFIX },
        OR: [{ orgId: null }, { orgId: { notIn: orgs.map((o) => o.id) } }],
      },
      data: { resolvedAt: now },
    });
  } catch (err) {
    console.error("[bot-health] could not close alerts for unmonitored clubs:", err);
  }

  return NextResponse.json({ ok: true, checked: orgs.length, report });
}
