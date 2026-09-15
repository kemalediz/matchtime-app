/**
 * THE HALF THAT NOTICES ABSENCE.
 *
 * A heartbeat driven by the Pi can only report failures the Pi survives.
 * The failures that cost the most — a crashed process, an unplugged Pi, a
 * dead SD card, a revoked WhatsApp session, an expired API key, a router
 * that came back on a different subnet — all have the same signature:
 * the Pi sends NOTHING. Nothing is not a message anybody receives. So
 * something that is not the Pi has to go looking, on a clock of its own.
 *
 * That is this route. Hourly, from `vercel.json`, over every org with the
 * bot enabled:
 *
 *   1. gather what the server already knows (last analysed message, last
 *      participant sweep, next fixture, unattributable senders) plus the
 *      Pi's latest self-report from `BotHealth`,
 *   2. hand all of it to `assessBotHealth` — pure, unit-tested, and where
 *      every threshold and every false-alarm guard is argued,
 *   3. if it decides a human needs telling, mail them, and additionally
 *      DM the org's admins when the message is worth an interruption,
 *      the Pi is demonstrably alive to deliver it, and it is not the
 *      middle of the night.
 *
 * ── One a day, and the two channels are not the same schedule ─────────
 *
 * Until 2026-09-15 an unchanged set of problems re-fired every six hours
 * down BOTH channels. Sutton FC's had not changed since 2026-07-07, so
 * the owner got 24 emails and 15 DMs in six days, three of which said
 * anything he had not read. He asked for one a day.
 *
 *   EMAIL  every alert. At most one a day for an unchanged set, plus
 *          anything genuinely new the moment it appears.
 *   DM     only when it is worth a buzz: something new, something
 *          long-running finally fixed, a still-unfixed CRITICAL, or a
 *          previous alert whose DM quiet hours swallowed.
 *
 * `planHealthAlert` owns and argues that split; this route only obeys
 * `plan.send` and `plan.dm`.
 *
 * ── Why email is the primary channel ──────────────────────────────────
 *
 * Because the alert must not depend on the layer it is alerting about.
 * The DM path is `BotJob` → `/api/whatsapp/due-posts` → the Pi →
 * whatsapp-web.js → WhatsApp. Every one of those is a thing that can be
 * the fault being reported, and in the flagship case (`pi-silent`) the
 * DM provably cannot be delivered, because the Pi is what delivers it.
 * The email path is Vercel cron → Resend → an inbox, and shares nothing
 * with the WhatsApp layer at all.
 *
 * The DM is still worth sending when it CAN be delivered — Kemal reads
 * WhatsApp faster than email, and a warning that the sweep is stale
 * belongs where he already is. It is an accelerator on a guaranteed
 * channel, never the channel itself.
 *
 * ── Hourly, not every 15 minutes ─────────────────────────────────────
 *
 * The silence threshold is 45 minutes, so hourly gives worst-case
 * detection of about an hour and three quarters. The brief asked for
 * "within hours", and the Tuesday chase runs at 17:00 for a 21:30
 * kickoff, so that is comfortably inside the window where somebody can
 * still act. Running it every 15 minutes would quadruple the invocations
 * to shave off minutes that no human is going to use.
 *
 * This route never writes to a match, an attendance, or the outbound
 * queue beyond one `BotJob` DM row. It cannot make an outage worse.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  assessBotHealth,
  composeHealthAlert,
  dmAllowedNow,
  planHealthAlert,
  trackFirstSeen,
  type HealthCounters,
  type HeartbeatSnapshot,
} from "@/lib/bot-health";
import { sendBotHealthAlertEmail } from "@/lib/email";
import { isNoneBucketShadowEnabled } from "@/lib/pipeline/gate";
import { NONE_SHADOW_BATCH_PREFIX } from "@/lib/pipeline/none-shadow";

/** Marker every health DM carries, so the dedupe can find its own kind. */
export const BOT_HEALTH_DM_MARKER = "MatchTime's WhatsApp layer is degraded";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const orgs = await db.organisation.findMany({
    where: { whatsappBotEnabled: true, whatsappGroupId: { not: null } },
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
    sent: boolean;
    reason: string;
    /** Did the email also earn a WhatsApp DM? See `planHealthAlert`. */
    dm: boolean;
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
        // `createdAt` at the first run — and "when did it last run" is
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

      const assessed = assessBotHealth({
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
      // Give every finding the date it started, and name anything that
      // has stopped. The ledger lives in one `Json?` column next to
      // `lastAlertCodes`, which is already the row's memory of the last
      // alert. `BotHealth.createdAt` is the fallback for a code this row
      // was already alerting on before the ledger existed: not when the
      // fault began, but the earliest instant this monitor could have
      // known, which is the only honest answer available.
      const { findings, ledger, resolved } = trackFirstSeen({
        findings: assessed,
        ledger: health?.codeFirstSeenAt ?? null,
        knownCodes: health?.lastAlertCodes ?? [],
        fallbackFirstSeen: health?.createdAt ?? now,
        now,
      });
      const codes = findings.map((f) => f.code);

      const plan = planHealthAlert({
        findings,
        resolved,
        lastAlertAt: health?.lastAlertAt ?? null,
        lastAlertCodes: health?.lastAlertCodes ?? [],
        now,
      });
      report.push({
        org: org.name,
        codes,
        sent: plan.send,
        reason: plan.reason,
        dm: plan.dm,
      });

      if (!plan.send) continue; // NOTE: nothing below this line runs for a
      // healthy org or one already alerted today — which is the entire
      // dispatch block and the dedupe write. Both are side effects only;
      // no assessment happens after this point, so skipping them is a
      // no-op rather than a guard being deleted.
      //
      // ONE CONSEQUENCE, SAID OUT LOUD, because it got longer on
      // 2026-09-15. The row's memory (`lastAlertCodes` + the ledger) is
      // written ONLY on a tick that sent. So a SHORT-lived fault that
      // appears and clears between two alerts leaves its code sitting in
      // `lastAlertCodes`, and if it comes back before the next digest it
      // does not read as new and does not break through. That window was
      // up to six hours and is now up to about a day.
      //
      // Left deliberately. Writing state on every tick would make a
      // flapping fault (a Pi on bad Wi-Fi crossing the 45-minute
      // `pi-silent` line) alert on every single return, which is the
      // noise this change exists to remove. The faults whose thresholds
      // are hours or days wide (`inbound-silent` at 18h,
      // `none-shadow-stale` at 30h, `sweep-stale` at a week) cannot
      // flap inside a day in the first place.

      const knownCodes = new Set(health?.lastAlertCodes ?? []);
      const alert = composeHealthAlert(org.name, findings, {
        now,
        resolved,
        freshCodes: codes.filter((c) => !knownCodes.has(c)),
      });
      if (!alert) continue; // unreachable while the plan said send; belt and braces.

      console.error(`[bot-health] ${alert.subject}\n${alert.text}`);
      const emailed = await sendBotHealthAlertEmail(alert);

      // The DM rides on top, and only when it is BOTH worth an
      // interruption and deliverable.
      //
      //   plan.dm      the judgement, argued in `planHealthAlert`: news,
      //                or a still-unfixed critical, or a previous alert
      //                whose DM quiet hours ate. A daily repeat of the
      //                same two warnings is not any of those, and that
      //                is the half of this change the owner will feel.
      //   piAlive      `pi-silent` means the queue it goes into is not
      //                being drained, so queueing it would leave a stale
      //                "the bot is down" DM to be delivered whenever the
      //                Pi comes back: confusing, and by then untrue.
      //   quiet hours  nothing here is actionable at 03:00, and a 03:00
      //                buzz is how a channel gets muted.
      const piAlive = !codes.includes("pi-silent");
      let dmsQueued = 0;
      if (plan.dm && piAlive && dmAllowedNow(now)) {
        const admins = await db.membership.findMany({
          where: { orgId: org.id, role: { in: ["ADMIN", "OWNER"] }, leftAt: null },
          select: { user: { select: { phoneNumber: true } } },
        });
        for (const m of admins) {
          if (!m.user.phoneNumber) continue;
          await db.botJob.create({
            data: {
              orgId: org.id,
              kind: "dm",
              phone: m.user.phoneNumber.replace(/^\+/, ""),
              text: alert.text,
            },
          });
          dmsQueued++;
        }
      }

      // Record what we said, so the next tick can tell "still broken"
      // from "something new". Written whether or not delivery succeeded:
      // if Resend is down, retrying the same alert every hour would flood
      // the log without improving anybody's chance of reading it, and the
      // CRITICAL line above already says the channel failed.
      await db.botHealth.upsert({
        where: { orgId: org.id },
        create: {
          orgId: org.id,
          // A findings set can exist with no heartbeat ever received (the
          // server-side rules read data an older Pi already produces), so
          // this row may have to be created here. `lastHeartbeatAt` stays
          // NULL — the honest value, and the one the assessor reads as
          // "never heard from" rather than as an outage. A sentinel date
          // here would make every pre-heartbeat org look permanently
          // dead from the next tick onward.
          lastAlertAt: now,
          lastAlertCodes: codes,
          codeFirstSeenAt: ledger,
        },
        update: { lastAlertAt: now, lastAlertCodes: codes, codeFirstSeenAt: ledger },
      });

      console.warn(
        `[bot-health] ${org.name}: alerted (${plan.reason}) — email=${emailed}, dms=${dmsQueued}`,
      );
    } catch (err) {
      // One org's bad data must never stop the sweep reaching the next
      // org. A monitoring job that dies on the first exception is a
      // monitoring job that reports nothing.
      console.error(`[bot-health] assessment failed for ${org.name}:`, err);
      report.push({ org: org.name, codes: [], sent: false, reason: "assessment threw", dm: false });
    }
  }

  return NextResponse.json({ ok: true, checked: orgs.length, report });
}
